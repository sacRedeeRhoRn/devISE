import fs from "node:fs/promises";
import path from "node:path";

import { CodexAppServerClient, type ThreadLike } from "./appServerClient.js";
import { runLoop, managedThreadName, spawnLoopProcess } from "./controller.js";
import { doctor as runDoctor, installAssets } from "./install.js";
import { ensureDir } from "./fs.js";
import { buildManagedRoleInstructions, buildRoleAssignmentPrime } from "./persona.js";
import { registryPath } from "./paths.js";
import {
  activeRolesForProject,
  createProjectFiles,
  ensureRoleAllowedForProject,
  hasManagedProjectConfig,
  loadProjectConfig,
  loadRuntimeState,
  resolveControllerLogPath,
  resolveRuntimeStatePath,
  saveRuntimeState,
} from "./project.js";
import {
  createPortfolioEntry,
  findRegistryEntryById,
  loadRegistry,
  moveManagedProject,
  upsertRegistryEntry,
} from "./registry.js";
import type { InstallResult } from "./install.js";
import {
  allowedStartRolesForLoopKind,
  type AssignmentInput,
  type CreatePortfolioInput,
  type CreateProjectInput,
  type LoopStartInput,
  type MoveProjectInput,
  type ProjectConfig,
  type RegistryEntry,
  type RuntimeState,
  type SessionSummary,
  type StageLaunchInput,
  type RoleKind,
} from "./types.js";

interface RoleServiceOptions {
  spawnLoop?: typeof spawnLoopProcess;
  createClient?: () => CodexAppServerClient;
}

export class RoleService {
  constructor(
    private readonly repoRoot: string,
    private readonly cliEntrypoint: string,
    private readonly options: RoleServiceOptions = {},
  ) {}

  private newClient(): CodexAppServerClient {
    return this.options.createClient?.() ?? new CodexAppServerClient();
  }

  async install(): Promise<InstallResult> {
    return installAssets(this.repoRoot, this.cliEntrypoint);
  }

  async doctor(projectRoot?: string): Promise<string[]> {
    const findings = await runDoctor(this.repoRoot, this.cliEntrypoint);
    const targetRoot = projectRoot ? path.resolve(projectRoot) : process.cwd();
    if (await hasManagedProjectConfig(targetRoot)) {
      const project = await loadProjectConfig(targetRoot);
      findings.push(`OK project config loaded for ${project.project.id}`);
      findings.push(`Runtime state path: ${await resolveRuntimeStatePath(targetRoot)}`);
      findings.push(`Controller log path: ${await resolveControllerLogPath(targetRoot)}`);
    }
    findings.push(`Registry path: ${registryPath()}`);
    return findings;
  }

  async createProject(input: CreateProjectInput): Promise<ProjectConfig> {
    const root = path.resolve(input.projectRoot);
    if (await hasManagedProjectConfig(root)) {
      throw new Error(`Project already exists at ${root}`);
    }

    let portfolio;
    if (input.headProjectId) {
      const entry = await findRegistryEntryById(input.headProjectId);
      if (!entry) {
        throw new Error(`Portfolio ${input.headProjectId} was not found`);
      }
      if (entry.kind !== "portfolio") {
        throw new Error(`${input.headProjectId} is not a portfolio`);
      }
      portfolio = entry;
    }

    const { project } = await createProjectFiles(
      { ...input, projectRoot: root },
      { portfolio },
    );
    await upsertRegistryEntry(project, input.headProjectId);
    return project;
  }

  async createPortfolio(input: CreatePortfolioInput) {
    return createPortfolioEntry(input);
  }

  async listProjects(): Promise<ProjectConfig[]> {
    const registry = await loadRegistry();
    const projects: ProjectConfig[] = [];
    for (const entry of registry.projects) {
      if (entry.kind !== "managed_project") {
        continue;
      }
      if (!(await hasManagedProjectConfig(entry.root))) {
        continue;
      }
      try {
        projects.push(await loadProjectConfig(entry.root));
      } catch {
        continue;
      }
    }
    return projects;
  }

  async resolveCurrentSession(projectRoot: string): Promise<SessionSummary | null> {
    const sessions = await this.listRecentSessions(projectRoot, 10);
    return sessions[0] ?? null;
  }

  async listRecentSessions(
    projectRoot: string,
    limit = 10,
  ): Promise<SessionSummary[]> {
    const client = this.newClient();
    try {
      const threads = await client.listThreads({
        cwd: path.resolve(projectRoot),
        sortKey: "updated_at",
        limit,
        sourceKinds: ["cli", "vscode", "appServer"],
        archived: false,
      });
      return threads.map(toSessionSummary);
    } finally {
      await client.close();
    }
  }

  async assignRole(input: AssignmentInput): Promise<RuntimeState> {
    const projectRoot = path.resolve(input.projectRoot);
    const project = await loadProjectConfig(projectRoot);
    const runtime = await loadRuntimeState(projectRoot);
    ensureRoleAllowedForProject(project, input.role);
    const client = this.newClient();

    try {
      const developerInstructions = await this.roleInstructions(project, input.role);
      let thread: ThreadLike;
      if (input.mode === "current") {
        const currentThreadId =
          input.currentThreadId ?? (await this.resolveCurrentSession(projectRoot))?.threadId;
        if (!currentThreadId) {
          throw new Error(`No current session could be resolved for ${projectRoot}`);
        }
        await client.connect();
        thread = await client.resumeThread({
          threadId: currentThreadId,
          cwd: project.project.root,
          approvalPolicy: "never",
          sandbox: "danger-full-access",
          developerInstructions,
          persistExtendedHistory: true,
        });
      } else {
        if (!input.threadId) {
          throw new Error(`threadId is required when assigning an old session`);
        }
        await client.connect();
        thread = await client.forkThread({
          threadId: input.threadId,
          cwd: project.project.root,
          approvalPolicy: "never",
          sandbox: "danger-full-access",
          developerInstructions,
          persistExtendedHistory: true,
        });
      }

      const threadName = managedThreadName(project.project.id, input.role);
      await client.setThreadName(thread.id, threadName);
      runtime.roles[input.role] = {
        role: input.role,
        threadId: thread.id,
        threadName,
        sourceMode: input.mode === "current" ? "current" : "fork",
        sourceThreadId: input.mode === "old" ? input.threadId : undefined,
        assignedAt: new Date().toISOString(),
      };
      await saveRuntimeState(runtime);
      await this.primeAssignedRole(client, project, thread.id, input.role);
      return runtime;
    } finally {
      await client.close();
    }
  }

  async moveProject(input: MoveProjectInput) {
    const root = await this.resolveProjectSelector(input.projectSelector);
    const project = await loadProjectConfig(root);
    return moveManagedProject(project.project.id, input.newHeadProjectId);
  }

  async stageLaunch(input: StageLaunchInput): Promise<RuntimeState> {
    const project = await loadProjectConfig(input.projectRoot);
    const runtime = await loadRuntimeState(input.projectRoot);
    syncControllerState(runtime);
    ensureValidStartRole(project, input.startRole);
    ensureActiveRolesAssigned(project, runtime);
    const task = input.task.trim();
    if (!task) {
      throw new Error(`stageLaunch requires a non-empty task`);
    }
    if (runtime.loop.status === "running" && runtime.loop.pid) {
      throw new Error(
        `Project ${runtime.projectId} already has a running controller (pid ${runtime.loop.pid})`,
      );
    }

    runtime.launch = {
      stagedStartRole: input.startRole,
      stagedTask: task,
      stagedAt: new Date().toISOString(),
    };
    await saveRuntimeState(runtime);
    return runtime;
  }

  async clearLaunch(projectRoot: string): Promise<RuntimeState> {
    const runtime = await loadRuntimeState(projectRoot);
    runtime.launch = {};
    await saveRuntimeState(runtime);
    return runtime;
  }

  async startLoop(input: LoopStartInput): Promise<RuntimeState> {
    const project = await loadProjectConfig(input.projectRoot);
    const runtime = await loadRuntimeState(input.projectRoot);
    const controllerAlive = syncControllerState(runtime);
    const startRole = input.startRole ?? runtime.launch.stagedStartRole;
    const nextTask = input.task?.trim() || runtime.launch.stagedTask?.trim();
    if (controllerAlive && runtime.loop.pid) {
      throw new Error(
        `Project ${runtime.projectId} already has a running controller (pid ${runtime.loop.pid})`,
      );
    }
    if (!startRole) {
      throw new Error(`startLoop requires a staged or explicit startRole`);
    }
    ensureValidStartRole(project, startRole);
    if (!nextTask) {
      throw new Error(`startLoop requires a staged or explicit non-empty task`);
    }
    ensureActiveRolesAssigned(project, runtime);

    await ensureDir(path.dirname(await resolveControllerLogPath(input.projectRoot)));
    const pid = await (this.options.spawnLoop ?? spawnLoopProcess)(
      this.cliEntrypoint,
      {
        projectRoot: input.projectRoot,
        startRole,
        task: nextTask,
      },
      runtime.projectId,
    );
    runtime.launch = {};
    runtime.loop.status = "running";
    runtime.loop.pid = pid;
    runtime.loop.task = nextTask;
    runtime.loop.iteration = 0;
    runtime.loop.startRole = startRole;
    runtime.loop.lastRole = undefined;
    runtime.loop.lastCommitSha = undefined;
    runtime.loop.lastReportPath = undefined;
    runtime.loop.startedAt = new Date().toISOString();
    runtime.loop.endedAt = undefined;
    runtime.loop.lastError = undefined;
    runtime.history = [];
    await saveRuntimeState(runtime);
    return runtime;
  }

  async stopLoop(projectRoot: string): Promise<RuntimeState> {
    const runtime = await loadRuntimeState(projectRoot);
    if (runtime.loop.pid && processExists(runtime.loop.pid)) {
      process.kill(runtime.loop.pid, "SIGTERM");
    }
    runtime.loop.status = "stopped";
    runtime.loop.pid = undefined;
    runtime.loop.endedAt = new Date().toISOString();
    await saveRuntimeState(runtime);
    return runtime;
  }

  async getStatus(projectRoot: string): Promise<{
    project: ProjectConfig;
    runtime: RuntimeState;
    controllerAlive: boolean;
    registryEntry?: RegistryEntry;
  }> {
    const resolvedRoot = await this.resolveProjectSelector(projectRoot);
    const project = await loadProjectConfig(resolvedRoot);
    const runtime = await loadRuntimeState(resolvedRoot);
    const controllerAlive = syncControllerState(runtime);
    if (runtime.loop.status === "orphaned" && !controllerAlive) {
      await saveRuntimeState(runtime);
    }
    const registryEntry = await findRegistryEntryById(project.project.id);
    return {
      project,
      runtime,
      controllerAlive,
      registryEntry,
    };
  }

  async runLoopForeground(
    input: LoopStartInput & { startRole: RoleKind; task: string },
  ): Promise<RuntimeState> {
    return runLoop(this.repoRoot, input);
  }

  private async resolveProjectSelector(selector: string): Promise<string> {
    const resolved = path.resolve(selector);
    if (await hasManagedProjectConfig(resolved)) {
      return resolved;
    }

    const registry = await loadRegistry();
    const match = registry.projects.find(
      (entry): entry is Extract<RegistryEntry, { kind: "managed_project" }> =>
        entry.kind === "managed_project" && entry.id === selector,
    );
    if (match) {
      return match.root;
    }

    return resolved;
  }

  private async roleInstructions(project: ProjectConfig, role: RoleKind): Promise<string> {
    const base = await fs.readFile(
      path.join(this.repoRoot, "assets", "roles", `${role}.md`),
      "utf8",
    );
    return buildManagedRoleInstructions(base, project, role);
  }

  private async primeAssignedRole(
    client: CodexAppServerClient,
    project: ProjectConfig,
    threadId: string,
    role: RoleKind,
  ): Promise<void> {
    const prime = buildRoleAssignmentPrime(project, role);
    if (!prime) {
      return;
    }

    const priorThread = await client.readThread(threadId, true);
    const priorTurnCount = priorThread.turns.length;
    await client.startTurn({
      threadId,
      input: [
        {
          type: "text",
          text: prime,
          text_elements: [],
        },
      ],
      cwd: project.project.root,
      approvalPolicy: "never",
      personality: "pragmatic",
    });
    await client.waitForTurnCompletion(threadId, 5 * 60 * 1000, priorTurnCount);
  }
}

function toSessionSummary(thread: ThreadLike): SessionSummary {
  return {
    threadId: thread.id,
    updatedAt: new Date(thread.updatedAt * 1000).toISOString(),
    preview: thread.preview,
    cwd: thread.cwd,
    name: thread.name,
    source: thread.source,
  };
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function syncControllerState(runtime: RuntimeState): boolean {
  const controllerAlive = Boolean(runtime.loop.pid && processExists(runtime.loop.pid));
  if (runtime.loop.status === "running" && !controllerAlive) {
    const exitedPid = runtime.loop.pid;
    runtime.loop.status = "orphaned";
    runtime.loop.endedAt ??= new Date().toISOString();
    runtime.loop.lastError ??= exitedPid
      ? `Controller process ${exitedPid} is no longer alive`
      : `Controller state was marked running without an active pid`;
    runtime.loop.pid = undefined;
  }
  return controllerAlive;
}

function ensureActiveRolesAssigned(project: ProjectConfig, runtime: RuntimeState): void {
  const missing = activeRolesForProject(project).filter((role) => !runtime.roles[role]);
  if (missing.length > 0) {
    throw new Error(
      `Both roles for ${project.loop_kind} must be assigned before starting the loop (missing: ${missing.join(", ")})`,
    );
  }
}

function ensureValidStartRole(project: ProjectConfig, startRole: RoleKind): void {
  const allowed = allowedStartRolesForLoopKind(project.loop_kind);
  if (!allowed.includes(startRole)) {
    throw new Error(
      `startRole ${startRole} is not valid for ${project.loop_kind} projects (allowed: ${allowed.join(", ")})`,
    );
  }
}
