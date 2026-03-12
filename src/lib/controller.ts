import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

import { CodexAppServerClient, type ThreadLike } from "./appServerClient.js";
import { ensureDir, pathExists, readTextIfExists } from "./fs.js";
import {
  repoRootFromModule,
  specPath,
} from "./paths.js";
import {
  ensureRoleAssigned,
  loadProjectConfig,
  loadRuntimeState,
  resolveArtifactsDir,
  resolveControllerLogPath,
  resolveProjectConfigPath,
  saveRuntimeState,
} from "./project.js";
import type {
  ControllerTurnResult,
  LoopStartInput,
  ProjectConfig,
  RoleKind,
  RuntimeState,
} from "./types.js";

type ResolvedLoopStartInput = LoopStartInput & {
  startRole: RoleKind;
  task: string;
};

const ROLE_OUTPUT_SCHEMAS: Record<RoleKind, Record<string, unknown>> = {
  developer: {
    type: "object",
    additionalProperties: false,
    required: ["status", "dry_test_passed", "summary", "handoff_report_path"],
    properties: {
      status: { type: "string", enum: ["green", "blocked"] },
      dry_test_passed: { type: "boolean" },
      summary: { type: "string" },
      handoff_report_path: { type: "string" },
      commit_sha: { type: "string" },
      blocking_reason: { type: "string" },
    },
  },
  debugger: {
    type: "object",
    additionalProperties: false,
    required: [
      "status",
      "use_passed",
      "summary",
      "report_path",
      "issues",
      "restart_performed",
      "monitor_result",
    ],
    properties: {
      status: { type: "string", enum: ["goal_met", "needs_fix", "blocked"] },
      use_passed: { type: "boolean" },
      summary: { type: "string" },
      report_path: { type: "string" },
      restart_performed: { type: "boolean" },
      monitor_result: {
        type: "string",
        enum: ["not_configured", "caveat_observed", "process_ended", "timeout_reached"],
      },
      observed_caveat: { type: "string" },
      issues: {
        type: "array",
        items: { type: "string" },
      },
      blocking_reason: { type: "string" },
    },
  },
};

export async function spawnLoopProcess(
  cliEntrypoint: string,
  input: ResolvedLoopStartInput,
  projectId: string,
): Promise<number> {
  const child = spawn(
    process.execPath,
    [
      cliEntrypoint,
      "run-loop",
      "--project-root",
      input.projectRoot,
      "--start-role",
      input.startRole,
      "--task",
      input.task,
    ],
    {
      detached: true,
      stdio: "ignore",
    },
  );
  child.unref();
  return child.pid ?? failMissingPid(projectId);
}

export async function runLoop(
  repoRoot: string,
  input: ResolvedLoopStartInput,
): Promise<RuntimeState> {
  const project = await loadProjectConfig(input.projectRoot);
  const runtime = await loadRuntimeState(input.projectRoot);
  ensureRoleAssigned(runtime, input.startRole);
  ensureRoleAssigned(runtime, input.startRole === "developer" ? "debugger" : "developer");

  validateRunnableProject(project);
  await ensureDir(await resolveArtifactsDir(project.project.root));
  await ensureManagedBranch(project.project.root, project.git.role_branch);

  runtime.loop.status = "running";
  runtime.loop.pid = process.pid;
  runtime.loop.task = input.task;
  runtime.loop.startedAt ??= new Date().toISOString();
  runtime.loop.startRole = input.startRole;
  runtime.loop.lastError = undefined;
  await saveRuntimeState(runtime);

  const client = new CodexAppServerClient();
  const previousOutcomeByRole = new Map<RoleKind, string>();
  let currentRole: RoleKind = input.startRole;
  let stagnationCount = 0;

  try {
    await client.connect();
    await hydrateRoleThreads(repoRoot, client, project, runtime);

    for (
      let iteration = runtime.loop.iteration + 1;
      iteration <= project.loop.max_iterations;
      iteration += 1
    ) {
      runtime.loop.iteration = iteration;
      runtime.loop.lastRole = currentRole;
      await saveRuntimeState(runtime);

      await ensureManagedBranch(project.project.root, project.git.role_branch);
      const result = await runRoleTurn(
        repoRoot,
        client,
        project,
        runtime,
        currentRole,
        iteration,
      );

      const artifactPath = result.report_path ?? result.handoff_report_path;
      const recordKey = JSON.stringify({
        role: currentRole,
        status: result.status,
        summary: result.summary,
        commit: result.commit_sha ?? "",
        artifactPath: artifactPath ?? "",
      });

      if (previousOutcomeByRole.get(currentRole) === recordKey) {
        stagnationCount += 1;
      } else {
        stagnationCount = 0;
      }
      previousOutcomeByRole.set(currentRole, recordKey);

      runtime.history.push({
        iteration,
        role: currentRole,
        status: result.status,
        summary: result.summary,
        artifactPath,
        commitSha: result.commit_sha,
        at: new Date().toISOString(),
      });
      runtime.loop.lastCommitSha = result.commit_sha ?? runtime.loop.lastCommitSha;
      runtime.loop.lastReportPath = artifactPath ?? runtime.loop.lastReportPath;
      await saveRuntimeState(runtime);

      if (stagnationCount >= project.loop.stagnation_limit) {
        runtime.loop.status = "failed";
        runtime.loop.lastError = `Loop stagnated after ${project.loop.stagnation_limit + 1} repeated ${currentRole} outcomes`;
        runtime.loop.endedAt = new Date().toISOString();
        runtime.loop.pid = undefined;
        await saveRuntimeState(runtime);
        return runtime;
      }

      if (result.status === "blocked") {
        runtime.loop.status = "blocked";
        runtime.loop.lastError = result.blocking_reason ?? `${currentRole} reported blocked`;
        runtime.loop.endedAt = new Date().toISOString();
        runtime.loop.pid = undefined;
        await saveRuntimeState(runtime);
        return runtime;
      }

      if (currentRole === "debugger" && result.status === "goal_met" && result.use_passed) {
        runtime.loop.status = "completed";
        runtime.loop.endedAt = new Date().toISOString();
        runtime.loop.pid = undefined;
        await saveRuntimeState(runtime);
        return runtime;
      }

      currentRole = currentRole === "developer" ? "debugger" : "developer";
    }

    runtime.loop.status = "failed";
    runtime.loop.lastError = `Reached max_iterations=${project.loop.max_iterations}`;
    runtime.loop.endedAt = new Date().toISOString();
    runtime.loop.pid = undefined;
    await saveRuntimeState(runtime);
    return runtime;
  } finally {
    await client.close();
  }
}

async function hydrateRoleThreads(
  repoRoot: string,
  client: CodexAppServerClient,
  project: ProjectConfig,
  runtime: RuntimeState,
): Promise<void> {
  for (const role of ["developer", "debugger"] as const) {
    const assigned = runtime.roles[role];
    if (assigned) {
      await client.resumeThread({
        threadId: assigned.threadId,
        cwd: project.project.root,
        approvalPolicy: "never",
        sandbox: "workspace-write",
        developerInstructions: await loadRoleBaseInstructions(repoRoot, role),
        persistExtendedHistory: true,
      });
      await client.setThreadName(assigned.threadId, assigned.threadName);
      continue;
    }

    const threadName = managedThreadName(project.project.id, role);
    const thread = await client.startThread({
      cwd: project.project.root,
      approvalPolicy: "never",
      sandbox: "workspace-write",
      developerInstructions: await loadRoleBaseInstructions(repoRoot, role),
      personality: "pragmatic",
      experimentalRawEvents: false,
      persistExtendedHistory: true,
    });
    await client.setThreadName(thread.id, threadName);
    runtime.roles[role] = {
      role,
      threadId: thread.id,
      threadName,
      sourceMode: "new",
      assignedAt: new Date().toISOString(),
    };
    await saveRuntimeState(runtime);
  }
}

async function runRoleTurn(
  repoRoot: string,
  client: CodexAppServerClient,
  project: ProjectConfig,
  runtime: RuntimeState,
  role: RoleKind,
  iteration: number,
): Promise<ControllerTurnResult> {
  ensureRoleAssigned(runtime, role);
  const roleSession = runtime.roles[role]!;
  const artifactDir = path.join(
    await resolveArtifactsDir(project.project.root),
    `iter-${String(iteration).padStart(3, "0")}`,
  );
  await ensureDir(artifactDir);
  const artifactPath = path.join(
    artifactDir,
    role === "developer" ? "developer-handoff.md" : "debugger-report.md",
  );
  const counterpartArtifact =
    runtime.loop.lastReportPath && (await pathExists(runtime.loop.lastReportPath))
      ? runtime.loop.lastReportPath
      : undefined;

  await client.resumeThread({
    threadId: roleSession.threadId,
    cwd: project.project.root,
    approvalPolicy: "never",
    sandbox: "workspace-write",
    developerInstructions: await loadRoleBaseInstructions(repoRoot, role),
    persistExtendedHistory: true,
  });

  const prompt = await buildRoleTurnPrompt(
    repoRoot,
    project,
    runtime,
    role,
    iteration,
    artifactPath,
    counterpartArtifact,
  );

  await client.startTurn({
    threadId: roleSession.threadId,
    input: [
      {
        type: "text",
        text: prompt,
        text_elements: [],
      },
    ],
    cwd: project.project.root,
    approvalPolicy: "never",
    outputSchema: ROLE_OUTPUT_SCHEMAS[role],
    personality: "pragmatic",
  });
  await client.waitForTurnCompletion(roleSession.threadId);

  const thread = await client.readThread(roleSession.threadId, true);
  const lastTurn = thread.turns.at(-1);
  if (!lastTurn) {
    throw new Error(`No completed turn found for ${roleSession.threadId}`);
  }

  if (lastTurn.status !== "completed") {
    throw new Error(
      `Turn for ${role} did not complete successfully (status=${lastTurn.status})`,
    );
  }

  const agentMessage = [...lastTurn.items]
    .reverse()
    .find((item) => item.type === "agentMessage" && item.text);
  if (!agentMessage?.text) {
    throw new Error(`No final agent message found for ${role}`);
  }

  const parsed = parseControllerTurnResult(agentMessage.text);
  if (role === "developer") {
    parsed.handoff_report_path ??= artifactPath;
    parsed.commit_sha ??= await readHeadSha(project.project.root);
  } else {
    parsed.report_path ??= artifactPath;
    validateDebuggerTurnResult(project, parsed);
  }

  await appendControllerLog(project.project.root, role, iteration, parsed);
  return parsed;
}

async function buildRoleTurnPrompt(
  repoRoot: string,
  project: ProjectConfig,
  runtime: RuntimeState,
  role: RoleKind,
  iteration: number,
  artifactPath: string,
  counterpartArtifact?: string,
): Promise<string> {
  const roleInstructions = await loadRoleBaseInstructions(repoRoot, role);
  const counterpartSummary =
    counterpartArtifact && (await pathExists(counterpartArtifact))
      ? await readTextIfExists(counterpartArtifact)
      : "No prior counterpart artifact is available.";
  const commands =
    role === "developer"
      ? renderCommandList(project.commands.dry_test)
      : renderCommandList(project.commands.use);
  const restartCommands = renderCommandList(project.commands.restart);
  const monitorCommands = renderCommandList(project.commands.monitor);
  const monitorUntil = renderBulletList(project.commands.monitor_until);
  const monitorTimeoutSeconds = project.commands.monitor_timeout_seconds ?? 300;
  const projectConfig = await resolveProjectConfigPath(project.project.root);

  return `${roleInstructions}

Project root: ${project.project.root}
Project spec: ${specPath(project.project.root)}
Project config: ${projectConfig}
Iteration: ${iteration}
Managed branch: ${project.git.role_branch}
Goal:
${project.goal}

User-requested task for this loop:
${runtime.loop.task ?? "No explicit user task was recorded."}

Acceptance criteria:
${project.acceptance.map((item) => `- ${item}`).join("\n")}

Commands for this role:
${commands}

Debugger clean restart commands:
${role === "debugger" ? restartCommands : "Not applicable for this role."}

Debugger monitor commands:
${role === "debugger" ? monitorCommands : "Not applicable for this role."}

Debugger monitoring caveats:
${role === "debugger" ? monitorUntil : "Not applicable for this role."}

Debugger monitoring timeout seconds:
${role === "debugger" ? String(monitorTimeoutSeconds) : "Not applicable for this role."}

Counterpart context:
${counterpartSummary}

Required artifact path: ${artifactPath}

Return JSON only.
`;
}

async function loadRoleBaseInstructions(
  repoRoot: string,
  role: RoleKind,
): Promise<string> {
  const rolePath = path.join(repoRoot, "assets", "roles", `${role}.md`);
  return fs.readFile(rolePath, "utf8");
}

function renderCommandList(commands?: string[]): string {
  if (!commands || commands.length === 0) {
    return "- None configured.";
  }

  return commands.map((command) => `- ${command}`).join("\n");
}

function renderBulletList(items?: string[]): string {
  if (!items || items.length === 0) {
    return "- None configured.";
  }

  return items.map((item) => `- ${item}`).join("\n");
}

function validateDebuggerTurnResult(
  project: ProjectConfig,
  result: ControllerTurnResult,
): void {
  const restartConfigured = (project.commands.restart?.length ?? 0) > 0;
  const monitoringConfigured =
    (project.commands.monitor?.length ?? 0) > 0 ||
    (project.commands.monitor_until?.length ?? 0) > 0;

  if (restartConfigured && result.status !== "blocked" && result.restart_performed !== true) {
    throw new Error("Debugger turn did not confirm executing the configured clean restart commands");
  }

  if (monitoringConfigured && result.monitor_result === "not_configured") {
    throw new Error("Debugger turn reported monitor_result=not_configured despite monitoring requirements");
  }

  if (result.monitor_result === "caveat_observed" && !result.observed_caveat) {
    throw new Error("Debugger turn reported caveat_observed without observed_caveat");
  }

  if (result.status === "goal_met" && result.monitor_result === "caveat_observed") {
    throw new Error("Debugger turn cannot report goal_met when a monitoring caveat was observed");
  }
}

export function managedThreadName(projectId: string, role: RoleKind): string {
  return `devISE:${projectId}:${role}`;
}

function parseControllerTurnResult(text: string): ControllerTurnResult {
  const trimmed = text.trim().replace(/^```json\s*/i, "").replace(/```$/i, "");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end < 0 || end <= start) {
    throw new Error(`Role output is not valid JSON: ${text}`);
  }

  const jsonText = trimmed.slice(start, end + 1);
  return JSON.parse(jsonText) as ControllerTurnResult;
}

async function ensureManagedBranch(projectRoot: string, branchName: string): Promise<void> {
  const isGitRepo = await runGit(projectRoot, ["rev-parse", "--is-inside-work-tree"]);
  if (isGitRepo.trim() !== "true") {
    throw new Error(`Project root ${projectRoot} is not a git repository`);
  }

  const branchExists = await runGitAllowFailure(projectRoot, [
    "show-ref",
    "--verify",
    `refs/heads/${branchName}`,
  ]);

  if (branchExists.code === 0) {
    await runGit(projectRoot, ["switch", branchName]);
    return;
  }

  await runGit(projectRoot, ["switch", "-c", branchName]);
}

async function readHeadSha(projectRoot: string): Promise<string | undefined> {
  const result = await runGitAllowFailure(projectRoot, ["rev-parse", "HEAD"]);
  return result.code === 0 ? result.stdout.trim() : undefined;
}

async function runGit(projectRoot: string, args: string[]): Promise<string> {
  const result = await runGitAllowFailure(projectRoot, args);
  if (result.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

async function runGitAllowFailure(
  projectRoot: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd: projectRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

async function appendControllerLog(
  projectRoot: string,
  role: RoleKind,
  iteration: number,
  result: ControllerTurnResult,
): Promise<void> {
  const line = `${new Date().toISOString()} iter=${iteration} role=${role} status=${result.status} summary=${JSON.stringify(result.summary)}\n`;
  await fs.appendFile(await resolveControllerLogPath(projectRoot), line, "utf8");
}

function validateRunnableProject(project: ProjectConfig): void {
  const placeholders = [...project.commands.dry_test, ...project.commands.use].filter((command) =>
    command.includes("Set commands."),
  );
  if (placeholders.length > 0) {
    throw new Error(
      `Project ${project.project.id} still contains placeholder commands in .devise/project.yaml`,
    );
  }
}

function failMissingPid(projectId: string): never {
  throw new Error(`Failed to spawn controller for project ${projectId}: missing pid`);
}
