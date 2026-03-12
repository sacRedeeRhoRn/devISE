import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { RoleService } from "../src/lib/service.js";
import {
  createProjectFiles,
  loadRuntimeState,
  saveRuntimeState,
} from "../src/lib/project.js";
import type { RoleKind } from "../src/lib/types.js";

function makeService(options?: ConstructorParameters<typeof RoleService>[2]): RoleService {
  return new RoleService(process.cwd(), path.join(process.cwd(), "dist/src/cli.js"), options);
}

test("startLoop requires both roles to be assigned before launch", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "devise-service-project-"));
  await createProjectFiles({
    projectRoot,
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
    /Both roles must be assigned before starting the loop/,
  );
});

test("stageLaunch persists the next flight seed without starting the loop", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "devise-service-stage-"));
  await createProjectFiles({
    projectRoot,
    goal: "Stage a launch",
    acceptance: ["launch is armed"],
    dryTestCommands: ["npm test"],
    useCommands: ["npm start"],
  });

  await assignBothRoles(projectRoot);
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
    goal: "Launch from staged state",
    acceptance: ["controller starts from staged seed"],
    dryTestCommands: ["npm test"],
    useCommands: ["npm start"],
  });

  await assignBothRoles(projectRoot);
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

test("clearLaunch removes staged launch and preserves role assignments", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "devise-service-clear-"));
  await createProjectFiles({
    projectRoot,
    goal: "Clear staged launch",
    acceptance: ["assignments stay"],
    dryTestCommands: ["npm test"],
    useCommands: ["npm start"],
  });

  await assignBothRoles(projectRoot);
  const runtime = await loadRuntimeState(projectRoot);
  runtime.launch = {
    stagedStartRole: "developer",
    stagedTask: "Patch the next issue",
    stagedAt: new Date().toISOString(),
  };
  await saveRuntimeState(runtime);

  const service = makeService();
  const cleared = await service.clearLaunch(projectRoot);

  assert.deepEqual(cleared.launch, {});
  assert.equal(cleared.roles.developer?.threadId, "developer-thread");
  assert.equal(cleared.roles.debugger?.threadId, "debugger-thread");
});

test("getStatus marks dead running controllers as orphaned", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "devise-service-status-"));
  await createProjectFiles({
    projectRoot,
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

async function assignBothRoles(projectRoot: string): Promise<void> {
  const runtime = await loadRuntimeState(projectRoot);
  runtime.roles.developer = makeRoleSession("developer");
  runtime.roles.debugger = makeRoleSession("debugger");
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
