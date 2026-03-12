import path from "node:path";

import { CodexAppServerClient, type ThreadLike } from "./appServerClient.js";
import { runLoop, managedThreadName, spawnLoopProcess } from "./controller.js";
import { doctor as runDoctor, installAssets } from "./install.js";
import { ensureDir, pathExists } from "./fs.js";
import {
  controllerLogPath,
  projectConfigPath,
  registryPath,
  runtimeStatePath,
} from "./paths.js";
import {
  createProjectFiles,
  loadProjectConfig,
  loadRuntimeState,
  saveRuntimeState,
} from "./project.js";
import { loadRegistry, upsertRegistryEntry } from "./registry.js";
import type { InstallResult } from "./install.js";
import type {
  AssignmentInput,
  CreateProjectInput,
  LoopStartInput,
  ProjectConfig,
  RuntimeState,
  SessionSummary,
} from "./types.js";

export class RoleService {
  constructor(
    private readonly repoRoot: string,
    private readonly cliEntrypoint: string,
  ) {}

  async install(): Promise<InstallResult> {
    return installAssets(this.repoRoot, this.cliEntrypoint);
  }

  async doctor(projectRoot?: string): Promise<string[]> {
    const findings = await runDoctor(this.repoRoot, this.cliEntrypoint);
    const targetRoot = projectRoot ? path.resolve(projectRoot) : process.cwd();
    if (await pathExists(projectConfigPath(targetRoot))) {
      const project = await loadProjectConfig(targetRoot);
      findings.push(`OK project config loaded for ${project.project.id}`);
      findings.push(`Runtime state path: ${runtimeStatePath(targetRoot)}`);
      findings.push(`Controller log path: ${controllerLogPath(targetRoot)}`);
    }
    findings.push(`Registry path: ${registryPath()}`);
    return findings;
  }

  async createProject(input: CreateProjectInput): Promise<ProjectConfig> {
    const root = path.resolve(input.projectRoot);
    if (await pathExists(projectConfigPath(root))) {
      throw new Error(`Project already exists at ${root}`);
    }

    const { project } = await createProjectFiles({ ...input, projectRoot: root });
    await upsertRegistryEntry(project);
    return project;
  }

  async listProjects(): Promise<ProjectConfig[]> {
    const registry = await loadRegistry();
    const projects: ProjectConfig[] = [];
    for (const entry of registry.projects) {
      if (!(await pathExists(projectConfigPath(entry.root)))) {
        continue;
      }
      projects.push(await loadProjectConfig(entry.root));
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
    const client = new CodexAppServerClient();
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
    const client = new CodexAppServerClient();

    try {
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
          sandbox: "workspace-write",
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
          sandbox: "workspace-write",
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
      return runtime;
    } finally {
      await client.close();
    }
  }

  async startLoop(input: LoopStartInput): Promise<RuntimeState> {
    const runtime = await loadRuntimeState(input.projectRoot);
    if (runtime.loop.status === "running" && runtime.loop.pid && processExists(runtime.loop.pid)) {
      throw new Error(
        `Project ${runtime.projectId} already has a running controller (pid ${runtime.loop.pid})`,
      );
    }

    await ensureDir(path.dirname(controllerLogPath(input.projectRoot)));
    const pid = await spawnLoopProcess(this.cliEntrypoint, input, runtime.projectId);
    runtime.loop.status = "running";
    runtime.loop.pid = pid;
    runtime.loop.startRole = input.startRole;
    runtime.loop.startedAt = new Date().toISOString();
    runtime.loop.endedAt = undefined;
    runtime.loop.lastError = undefined;
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
  }> {
    const resolvedRoot = await this.resolveProjectSelector(projectRoot);
    const project = await loadProjectConfig(resolvedRoot);
    const runtime = await loadRuntimeState(resolvedRoot);
    return {
      project,
      runtime,
      controllerAlive: Boolean(runtime.loop.pid && processExists(runtime.loop.pid)),
    };
  }

  async runLoopForeground(input: LoopStartInput): Promise<RuntimeState> {
    return runLoop(this.repoRoot, input);
  }

  private async resolveProjectSelector(selector: string): Promise<string> {
    const resolved = path.resolve(selector);
    if (await pathExists(projectConfigPath(resolved))) {
      return resolved;
    }

    const registry = await loadRegistry();
    const match = registry.projects.find((entry) => entry.id === selector);
    if (match) {
      return match.root;
    }

    return resolved;
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
