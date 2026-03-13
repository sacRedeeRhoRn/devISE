import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";

import { RoleService } from "../src/lib/service.js";
import {
  createProjectFiles,
  loadRuntimeState,
  resolveWatchEventsPath,
  saveRuntimeState,
} from "../src/lib/project.js";
import type { ThreadLike } from "../src/lib/appServerClient.js";
import type { RoleKind } from "../src/lib/types.js";

function makeService(options?: ConstructorParameters<typeof RoleService>[2]): RoleService {
  return new RoleService(process.cwd(), path.join(process.cwd(), "dist/src/cli.js"), options);
}

test("startLoop requires both active roles to be assigned before launch", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "devise-service-project-"));
  await createProjectFiles({
    projectRoot,
    loopKind: "developer-debugger",
    goal: "Require both roles",
    acceptance: ["roles must be assigned first"],
    dryTestCommands: ["npm test"],
    useCommands: ["npm start"],
  });

  const service = makeService();
  await assert.rejects(
    () =>
      service.startLoop({
        projectRoot,
        startRole: "developer",
        task: "Implement the next requested change",
      }),
    /Both roles for developer-debugger must be assigned before starting the loop/,
  );
});

test("stageLaunch persists the next flight seed without starting the loop", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "devise-service-stage-"));
  await createProjectFiles({
    projectRoot,
    loopKind: "developer-debugger",
    goal: "Stage a launch",
    acceptance: ["launch is armed"],
    dryTestCommands: ["npm test"],
    useCommands: ["npm start"],
  });

  await assignActiveRoles(projectRoot, "developer-debugger");
  const service = makeService();
  const runtime = await service.stageLaunch({
    projectRoot,
    startRole: "debugger",
    task: "Run the first real-use verification pass",
  });

  assert.equal(runtime.loop.status, "idle");
  assert.equal(runtime.loop.pid, undefined);
  assert.equal(runtime.launch.stagedStartRole, "debugger");
  assert.equal(runtime.launch.stagedTask, "Run the first real-use verification pass");
});

test("startLoop uses staged launch state and resets per-run loop fields", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "devise-service-flight-"));
  await createProjectFiles({
    projectRoot,
    loopKind: "developer-debugger",
    goal: "Launch from staged state",
    acceptance: ["controller starts from staged seed"],
    dryTestCommands: ["npm test"],
    useCommands: ["npm start"],
  });

  await assignActiveRoles(projectRoot, "developer-debugger");
  const runtime = await loadRuntimeState(projectRoot);
  runtime.loop.status = "orphaned";
  runtime.loop.iteration = 4;
  runtime.loop.task = "Old task";
  runtime.loop.lastRole = "debugger";
  runtime.loop.lastCommitSha = "deadbeef";
  runtime.loop.lastReportPath = "/tmp/old-report.md";
  runtime.loop.lastError = "Old orphaned loop";
  runtime.history = [
    {
      iteration: 4,
      role: "debugger",
      status: "needs_fix",
      summary: "Old report",
      artifactPath: "/tmp/old-report.md",
      at: new Date().toISOString(),
    },
  ];
  runtime.launch = {
    stagedStartRole: "developer",
    stagedTask: "Implement the next patch set",
    stagedAt: new Date().toISOString(),
  };
  await saveRuntimeState(runtime);

  const service = makeService({
    spawnLoop: async (_cliEntrypoint, _input, _projectId) => 43210,
  });
  const launched = await service.startLoop({ projectRoot });

  assert.equal(launched.loop.status, "running");
  assert.equal(launched.loop.pid, 43210);
  assert.equal(launched.loop.startRole, "developer");
  assert.equal(launched.loop.task, "Implement the next patch set");
  assert.equal(launched.loop.iteration, 0);
  assert.equal(launched.loop.lastRole, undefined);
  assert.equal(launched.loop.lastCommitSha, undefined);
  assert.equal(launched.loop.lastReportPath, undefined);
  assert.equal(launched.loop.lastError, undefined);
  assert.deepEqual(launched.launch, {});
  assert.deepEqual(launched.history, []);
});

test("scientist-modeller projects only accept scientist as the start role", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "devise-service-science-"));
  await createProjectFiles({
    projectRoot,
    loopKind: "scientist-modeller",
    goal: "Fit an analytic model",
    acceptance: ["Scientist accepts the model"],
    scientistResearchCommands: ["python research.py"],
    modellerDesignCommands: ["python model.py"],
    scientistAssessCommands: ["python assess.py"],
  });

  await assignActiveRoles(projectRoot, "scientist-modeller");
  const service = makeService();

  await assert.rejects(
    () =>
      service.stageLaunch({
        projectRoot,
        startRole: "modeller",
        task: "Start from the model side",
      }),
    /startRole modeller is not valid for scientist-modeller projects/,
  );
});

test("clearLaunch removes staged launch and preserves active-role assignments", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "devise-service-clear-"));
  await createProjectFiles({
    projectRoot,
    loopKind: "scientist-modeller",
    goal: "Clear staged launch",
    acceptance: ["assignments stay"],
    scientistResearchCommands: ["python research.py"],
    modellerDesignCommands: ["python model.py"],
    scientistAssessCommands: ["python assess.py"],
  });

  await assignActiveRoles(projectRoot, "scientist-modeller");
  const runtime = await loadRuntimeState(projectRoot);
  runtime.launch = {
    stagedStartRole: "scientist",
    stagedTask: "Assess the latest model",
    stagedAt: new Date().toISOString(),
  };
  await saveRuntimeState(runtime);

  const service = makeService();
  const cleared = await service.clearLaunch(projectRoot);

  assert.deepEqual(cleared.launch, {});
  assert.equal(cleared.roles.scientist?.threadId, "scientist-thread");
  assert.equal(cleared.roles.modeller?.threadId, "modeller-thread");
});

test("getStatus marks dead running controllers as orphaned", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "devise-service-status-"));
  await createProjectFiles({
    projectRoot,
    loopKind: "developer-debugger",
    goal: "Detect orphaned loop state",
    acceptance: ["status should be clear"],
    dryTestCommands: ["npm test"],
    useCommands: ["npm start"],
  });

  const runtime = await loadRuntimeState(projectRoot);
  runtime.loop.status = "running";
  runtime.loop.pid = 99999999;
  runtime.loop.task = "Continue the assigned task";
  await saveRuntimeState(runtime);

  const service = makeService();
  const status = await service.getStatus(projectRoot);

  assert.equal(status.controllerAlive, false);
  assert.equal(status.runtime.loop.status, "orphaned");
  assert.equal(status.runtime.loop.pid, undefined);
  assert.match(status.runtime.loop.lastError ?? "", /no longer alive|without an active pid/);
});

test("assignRole applies generated expert instructions and visible priming for v3 projects", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "devise-service-assign-"));
  await createProjectFiles({
    projectRoot,
    loopKind: "scientist-modeller",
    goal: "Refine the entropy production assessment workflow",
    domain: "statistical thermodynamics",
    acceptance: ["Scientist signs off with explicit evidence"],
    scientistResearchCommands: ["python research.py"],
    modellerDesignCommands: ["python model.py"],
    scientistAssessCommands: ["python assess.py"],
  });

  const client = new FakeServiceClient();
  const service = makeService({
    createClient: () => client as never,
  });

  const runtime = await service.assignRole({
    projectRoot,
    role: "scientist",
    mode: "current",
    currentThreadId: "existing-thread",
  });

  assert.equal(runtime.roles.scientist?.threadId, "existing-thread");
  const resumeInstructions = String(client.resumeParams?.developerInstructions ?? "");
  assert.match(resumeInstructions, /Boltzmann|Prigogine|Gibbs/);
  assert.match(resumeInstructions, /Managed charter/);
  assert.equal(client.turnInputs.length, 1);
  assert.match(client.turnInputs[0] ?? "", /standing by/);
});

test("assignRole can create a fresh managed role session", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "devise-service-assign-new-"));
  await createProjectFiles({
    projectRoot,
    loopKind: "developer-debugger",
    goal: "Create fresh managed threads",
    acceptance: ["managed threads can be provisioned automatically"],
    dryTestCommands: ["npm test"],
    useCommands: ["npm start"],
  });

  const client = new FakeServiceClient();
  const service = makeService({
    createClient: () => client as never,
  });

  const runtime = await service.assignRole({
    projectRoot,
    role: "developer",
    mode: "new",
  });

  assert.equal(runtime.roles.developer?.sourceMode, "new");
  assert.equal(client.startThreadParams?.cwd, projectRoot);
  assert.equal(runtime.roles.developer?.threadId, "fresh-thread");
});

test("assignRole primes a fresh managed role session even before the thread is materialized", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "devise-service-assign-unmaterialized-"));
  await createProjectFiles({
    projectRoot,
    loopKind: "developer-debugger",
    goal: "Prime a fresh unmaterialized session",
    acceptance: ["fresh sessions can be primed safely"],
    dryTestCommands: ["npm test"],
    useCommands: ["npm start"],
  });

  const client = new FakeServiceClient({ unmaterializedUntilFirstTurn: true });
  const service = makeService({
    createClient: () => client as never,
  });

  const runtime = await service.assignRole({
    projectRoot,
    role: "developer",
    mode: "new",
  });

  assert.equal(runtime.roles.developer?.threadId, "fresh-thread");
  assert.equal(client.turnInputs.length, 1);
  assert.match(client.turnInputs[0] ?? "", /standing by/i);
});

test("assignRole defaults to a fresh managed role session when mode is omitted", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "devise-service-assign-default-"));
  await createProjectFiles({
    projectRoot,
    loopKind: "developer-debugger",
    goal: "Default to fresh managed assignment",
    acceptance: ["roles default to new managed sessions"],
    dryTestCommands: ["npm test"],
    useCommands: ["npm start"],
  });

  const client = new FakeServiceClient();
  const service = makeService({
    createClient: () => client as never,
  });

  const runtime = await service.assignRole({
    projectRoot,
    role: "debugger",
  });

  assert.equal(runtime.roles.debugger?.sourceMode, "new");
  assert.equal(runtime.roles.debugger?.threadId, "fresh-thread");
  assert.equal(client.resumeParams, undefined);
  assert.equal(client.startThreadParams?.cwd, projectRoot);
});

test("portfolio defaults are copied into new child projects and moveProject only changes registry linkage", async () => {
  const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "devise-home-"));
  const originalHome = process.env.HOME;
  process.env.HOME = tmpHome;

  try {
    const service = makeService();
    const portfolio = await service.createPortfolio({
      title: "Thermo Portfolio",
      goal: "Coordinate non-equilibrium transport programs",
      domain: "statistical thermodynamics",
      scientistPersonaHint: "prioritize non-equilibrium rigor",
    });
    const otherPortfolio = await service.createPortfolio({
      title: "Alt Portfolio",
      goal: "Alternative parent",
    });

    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "devise-service-portfolio-project-"));
    const project = await service.createProject({
      projectRoot,
      loopKind: "scientist-modeller",
      headProjectId: portfolio.id,
      goal: "Characterize entropy production under driven transport",
      acceptance: ["Scientist accepts the final model"],
      scientistResearchCommands: ["python research.py"],
      modellerDesignCommands: ["python model.py"],
      scientistAssessCommands: ["python assess.py"],
    });

    assert.equal(project.charter?.domain, "Statistical Thermodynamics");
    assert.match(project.roles.scientist?.persona?.methods.join(" | ") ?? "", /non-equilibrium rigor/);

    const moved = await service.moveProject({
      projectSelector: project.project.id,
      newHeadProjectId: otherPortfolio.id,
    });
    assert.equal(moved.parentId, otherPortfolio.id);

    const detached = await service.moveProject({
      projectSelector: project.project.id,
      newHeadProjectId: null,
    });
    assert.equal(detached.parentId, undefined);

    const reloaded = await service.getStatus(project.project.root);
    assert.equal(reloaded.project.charter?.domain, "Statistical Thermodynamics");
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    await fs.rm(tmpHome, { recursive: true, force: true });
  }
});

test("listRegistryOverview groups portfolios and surfaces the latest reasoning summary", async () => {
  const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "devise-home-overview-"));
  const originalHome = process.env.HOME;
  process.env.HOME = tmpHome;

  try {
    const service = makeService();
    const portfolio = await service.createPortfolio({
      title: "Runtime Programs",
      goal: "Track all active runtime projects",
      domain: "systems engineering",
    });

    const childRoot = await fs.mkdtemp(path.join(os.tmpdir(), "devise-service-overview-child-"));
    const child = await service.createProject({
      projectRoot: childRoot,
      loopKind: "developer-debugger",
      headProjectId: portfolio.id,
      goal: "Harden the runtime monitor",
      acceptance: ["runtime monitor stays healthy"],
      dryTestCommands: ["npm test"],
      useCommands: ["npm start"],
    });
    const childRuntime = await loadRuntimeState(childRoot);
    childRuntime.roles.developer = makeRoleSession("developer");
    childRuntime.roles.debugger = makeRoleSession("debugger");
    childRuntime.loop.status = "running";
    childRuntime.loop.pid = process.pid;
    childRuntime.loop.iteration = 3;
    childRuntime.loop.startRole = "developer";
    childRuntime.loop.lastRole = "debugger";
    childRuntime.loop.task = "Track reasoning snapshots";
    await saveRuntimeState(childRuntime);
    await fs.writeFile(
      await resolveWatchEventsPath(childRoot),
      `${JSON.stringify({
        version: 1,
        at: "2026-03-13T03:00:00.000Z",
        kind: "reasoning_snapshot",
        role: "debugger",
        iteration: 3,
        message: "Debugger reasoning: Verify runtime health | watch stream healthy | next: keep monitoring",
        reasoning: {
          intent: "Verify runtime health",
          current_step: "Check the watch stream",
          finding_or_risk: "watch stream healthy",
          next_action: "keep monitoring",
        },
      })}\n`,
      "utf8",
    );

    const topLevelRoot = await fs.mkdtemp(path.join(os.tmpdir(), "devise-service-overview-top-"));
    await service.createProject({
      projectRoot: topLevelRoot,
      loopKind: "developer-debugger",
      goal: "Standalone project",
      acceptance: ["top-level projects remain visible"],
      dryTestCommands: ["npm test"],
      useCommands: ["npm start"],
    });

    const overview = await service.listRegistryOverview();

    assert.equal(overview.portfolios.length, 1);
    assert.equal(overview.portfolios[0]?.projects.length, 1);
    assert.equal(overview.portfolios[0]?.projects[0]?.id, child.project.id);
    assert.match(overview.portfolios[0]?.projects[0]?.latestReasoning ?? "", /Check the watch stream/);
    assert.equal(overview.runningProjects[0]?.id, child.project.id);
    assert.equal(overview.topLevelProjects.length, 1);
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    await fs.rm(tmpHome, { recursive: true, force: true });
  }
});

async function assignActiveRoles(
  projectRoot: string,
  loopKind: "developer-debugger" | "scientist-modeller",
): Promise<void> {
  const runtime = await loadRuntimeState(projectRoot);
  if (loopKind === "developer-debugger") {
    runtime.roles.developer = makeRoleSession("developer");
    runtime.roles.debugger = makeRoleSession("debugger");
  } else {
    runtime.roles.scientist = makeRoleSession("scientist");
    runtime.roles.modeller = makeRoleSession("modeller");
  }
  await saveRuntimeState(runtime);
}

function makeRoleSession(role: RoleKind) {
  return {
    role,
    threadId: `${role}-thread`,
    threadName: `devISE:test:${role}`,
    sourceMode: "current" as const,
    assignedAt: new Date().toISOString(),
  };
}

class FakeServiceClient extends EventEmitter {
  resumeParams?: Record<string, unknown>;
  startThreadParams?: Record<string, unknown>;
  turnInputs: string[] = [];
  constructor(
    private readonly options: {
      unmaterializedUntilFirstTurn?: boolean;
    } = {},
  ) {
    super();
  }
  private readonly thread: ThreadLike = {
    id: "existing-thread",
    preview: "assigned thread",
    updatedAt: 0,
    cwd: process.cwd(),
    source: "cli",
    name: null,
    agentRole: null,
    turns: [],
  };

  async connect(): Promise<void> {}

  async close(): Promise<void> {}

  async resumeThread(params: Record<string, unknown>): Promise<ThreadLike> {
    this.resumeParams = params;
    return this.thread;
  }

  async forkThread(_params: Record<string, unknown>): Promise<ThreadLike> {
    return this.thread;
  }

  async startThread(params: Record<string, unknown>): Promise<ThreadLike> {
    this.startThreadParams = params;
    this.thread.id = "fresh-thread";
    return this.thread;
  }

  async setThreadName(threadId: string, name: string): Promise<void> {
    this.thread.id = threadId;
    this.thread.name = name;
  }

  async readThread(_threadId: string, _includeTurns = true): Promise<ThreadLike> {
    if (
      this.options.unmaterializedUntilFirstTurn &&
      _includeTurns &&
      this.thread.turns.length === 0
    ) {
      throw new Error(
        `thread ${this.thread.id} is not materialized yet; includeTurns is unavailable before first user message (code -32600)`,
      );
    }
    return this.thread;
  }

  async startTurn(params: Record<string, unknown>): Promise<void> {
    const input = (params.input as Array<{ text?: string }> | undefined) ?? [];
    this.turnInputs.push(input[0]?.text ?? "");
    this.thread.turns.push({
      id: `turn-${this.thread.turns.length + 1}`,
      status: "completed",
      items: [
        {
          id: `item-${this.thread.turns.length + 1}`,
          type: "agentMessage",
          text: "Primed and standing by.",
        },
      ],
    });
  }

  async waitForTurnCompletion(
    _threadId: string,
    _timeoutMs = 0,
    _priorTurnCount = 0,
  ): Promise<void> {}
}
