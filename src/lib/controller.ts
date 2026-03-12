import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

import {
  CodexAppServerClient,
  type ThreadItemLike,
  type ThreadLike,
  type ThreadTurnLike,
} from "./appServerClient.js";
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
  resolveWatchEventsPath,
  saveRuntimeState,
} from "./project.js";
import type {
  ControllerTurnResult,
  LoopStartInput,
  ProjectConfig,
  RoleKind,
  RuntimeState,
  WatchEventRecord,
} from "./types.js";

type ResolvedLoopStartInput = LoopStartInput & {
  startRole: RoleKind;
  task: string;
};

const ROLE_OUTPUT_SCHEMAS: Record<RoleKind, Record<string, unknown>> = {
  developer: strictObjectSchema({
      status: { type: "string", enum: ["green", "blocked"] },
      dry_test_passed: { type: "boolean" },
      summary: { type: "string" },
      handoff_report_path: { type: "string" },
      commit_sha: nullableStringSchema(),
      blocking_reason: nullableStringSchema(),
    }),
  debugger: strictObjectSchema({
      status: { type: "string", enum: ["goal_met", "needs_fix", "blocked"] },
      use_passed: { type: "boolean" },
      summary: { type: "string" },
      report_path: { type: "string" },
      restart_performed: { type: "boolean" },
      monitor_result: {
        type: "string",
        enum: ["not_configured", "caveat_observed", "process_ended", "timeout_reached"],
      },
      observed_caveat: nullableStringSchema(),
      issues: {
        type: "array",
        items: { type: "string" },
      },
      blocking_reason: nullableStringSchema(),
    }),
};

export const roleOutputSchemasForTest = ROLE_OUTPUT_SCHEMAS;

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
  await appendWatchEvent(project.project.root, {
    kind: "loop_started",
    role: input.startRole,
    status: "running",
    message: `Loop started with ${input.startRole} as the first role`,
  });

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
      await appendWatchEvent(project.project.root, {
        kind: "turn_started",
        iteration,
        role: currentRole,
        status: "inProgress",
        threadId: runtime.roles[currentRole]?.threadId,
        message: `${capitalizeRole(currentRole)} turn started`,
      });

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
        await appendWatchEvent(project.project.root, {
          kind: "loop_failed",
          iteration,
          role: currentRole,
          status: "failed",
          message: `Loop failed: ${runtime.loop.lastError}`,
        });
        return runtime;
      }

      if (result.status === "blocked") {
        runtime.loop.status = "blocked";
        runtime.loop.lastError = result.blocking_reason ?? `${currentRole} reported blocked`;
        runtime.loop.endedAt = new Date().toISOString();
        runtime.loop.pid = undefined;
        await saveRuntimeState(runtime);
        await appendWatchEvent(project.project.root, {
          kind: "loop_blocked",
          iteration,
          role: currentRole,
          status: "blocked",
          message: `Loop blocked: ${runtime.loop.lastError}`,
        });
        return runtime;
      }

      if (currentRole === "debugger" && result.status === "goal_met" && result.use_passed) {
        runtime.loop.status = "completed";
        runtime.loop.endedAt = new Date().toISOString();
        runtime.loop.pid = undefined;
        await saveRuntimeState(runtime);
        await appendWatchEvent(project.project.root, {
          kind: "loop_completed",
          iteration,
          role: currentRole,
          status: "completed",
          message: "Loop completed successfully",
        });
        return runtime;
      }

      currentRole = currentRole === "developer" ? "debugger" : "developer";
    }

    runtime.loop.status = "failed";
    runtime.loop.lastError = `Reached max_iterations=${project.loop.max_iterations}`;
    runtime.loop.endedAt = new Date().toISOString();
    runtime.loop.pid = undefined;
    await saveRuntimeState(runtime);
    await appendWatchEvent(project.project.root, {
      kind: "loop_failed",
      status: "failed",
      message: `Loop failed: ${runtime.loop.lastError}`,
    });
    return runtime;
  } catch (error) {
    runtime.loop.status = "failed";
    runtime.loop.lastError = error instanceof Error ? error.message : String(error);
    runtime.loop.endedAt = new Date().toISOString();
    runtime.loop.pid = undefined;
    await saveRuntimeState(runtime);
    await appendWatchEvent(project.project.root, {
      kind: "loop_failed",
      role: currentRole,
      status: "failed",
      message: `Loop failed: ${runtime.loop.lastError}`,
    });
    throw error;
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
        sandbox: "danger-full-access",
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
      sandbox: "danger-full-access",
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
    sandbox: "danger-full-access",
    developerInstructions: await loadRoleBaseInstructions(repoRoot, role),
    persistExtendedHistory: true,
  });
  const priorThread = await client.readThread(roleSession.threadId, true);
  const priorTurnCount = priorThread.turns.length;

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
  const activityMonitor = startTurnActivityMonitor(
    client,
    project.project.root,
    roleSession.threadId,
    role,
    iteration,
    priorTurnCount,
  );
  let thread: ThreadLike;
  try {
    await client.waitForTurnCompletion(roleSession.threadId, 30 * 60 * 1000, priorTurnCount);
    thread = await readTerminalTurnSnapshot(client, roleSession.threadId, priorTurnCount);
  } finally {
    await activityMonitor.stop();
  }
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

  const finalArtifactPath = parsed.report_path ?? parsed.handoff_report_path;
  if (finalArtifactPath) {
    await appendWatchEvent(project.project.root, {
      kind: "artifact_written",
      iteration,
      role,
      message: `${capitalizeRole(role)} updated ${path.basename(finalArtifactPath)}`,
      artifactPath: finalArtifactPath,
    });
  }
  if (parsed.commit_sha) {
    await appendWatchEvent(project.project.root, {
      kind: "commit_recorded",
      iteration,
      role,
      message: `${capitalizeRole(role)} recorded commit ${parsed.commit_sha.slice(0, 12)}`,
      commitSha: parsed.commit_sha,
    });
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

During the turn, emit brief progress updates before or after major phases so the live monitor can track what you are doing.
Your final assistant message must be JSON only.
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

async function readTerminalTurnSnapshot(
  client: CodexAppServerClient,
  threadId: string,
  priorTurnCount: number,
): Promise<ThreadLike> {
  let lastThread: ThreadLike | undefined;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const thread = await client.readThread(threadId, true);
    lastThread = thread;
    if (thread.turns.length > priorTurnCount) {
      const lastTurn = thread.turns.at(-1);
      if (
        lastTurn &&
        ["completed", "failed", "interrupted"].includes(lastTurn.status)
      ) {
        return thread;
      }
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 500);
    });
  }

  if (lastThread) {
    return lastThread;
  }

  return client.readThread(threadId, true);
}

function startTurnActivityMonitor(
  client: CodexAppServerClient,
  projectRoot: string,
  threadId: string,
  role: RoleKind,
  iteration: number,
  priorTurnCount: number,
): { stop: () => Promise<void> } {
  let stopped = false;
  const seenKeys = new Set<string>();

  const pump = (async () => {
    while (!stopped) {
      const terminal = await captureThreadObservableEvents(
        client,
        projectRoot,
        threadId,
        role,
        iteration,
        priorTurnCount,
        seenKeys,
      );
      if (terminal) {
        return;
      }
      await delay(1000);
    }
  })();

  return {
    stop: async () => {
      stopped = true;
      await captureThreadObservableEvents(
        client,
        projectRoot,
        threadId,
        role,
        iteration,
        priorTurnCount,
        seenKeys,
      );
      await pump.catch(() => {});
    },
  };
}

async function captureThreadObservableEvents(
  client: CodexAppServerClient,
  projectRoot: string,
  threadId: string,
  role: RoleKind,
  iteration: number,
  priorTurnCount: number,
  seenKeys: Set<string>,
): Promise<boolean> {
  let thread: ThreadLike;
  try {
    thread = await client.readThread(threadId, true);
  } catch {
    return false;
  }

  if (thread.turns.length <= priorTurnCount) {
    return false;
  }

  const turn = thread.turns.at(-1);
  if (!turn) {
    return false;
  }

  const terminal = ["completed", "failed", "interrupted"].includes(turn.status);
  const turnStatusEvent: WatchEventRecord = {
    version: 1,
    at: new Date().toISOString(),
    kind: "turn_status",
    iteration,
    role,
    status: turn.status,
    threadId,
    message: `${capitalizeRole(role)} turn is ${turn.status}`,
  };
  await appendWatchEventIfNew(projectRoot, turnStatusEvent, seenKeys);

  for (const event of extractObservableTurnEvents(turn, role, iteration, threadId)) {
    await appendWatchEventIfNew(projectRoot, event, seenKeys);
  }

  return terminal;
}

function extractObservableTurnEvents(
  turn: ThreadTurnLike,
  role: RoleKind,
  iteration: number,
  threadId: string,
): WatchEventRecord[] {
  const events: WatchEventRecord[] = [];

  for (const item of turn.items) {
    if (item.type === "agentMessage") {
      const text = normalizeMessage(extractItemText(item));
      if (!text || looksLikeJsonObject(text)) {
        continue;
      }
      events.push({
        version: 1,
        at: new Date().toISOString(),
        kind: "commentary",
        iteration,
        role,
        status: turn.status,
        threadId,
        itemId: item.id,
        itemType: item.type,
        message: text,
      });
      continue;
    }

    if (item.type === "commandExecution") {
      const finished = item.status === "completed" || item.status === "failed";
      const command = item.command?.trim();
      events.push({
        version: 1,
        at: new Date().toISOString(),
        kind: finished ? "command_finished" : "command_started",
        iteration,
        role,
        status: item.status ?? turn.status,
        threadId,
        itemId: item.id,
        itemType: item.type,
        command,
        outputPreview: finished ? previewOutput(item.aggregatedOutput) : undefined,
        message: finished
          ? `${capitalizeRole(role)} ${item.status === "failed" ? "failed" : "completed"} ${shortCommand(command)}`
          : `${capitalizeRole(role)} running ${shortCommand(command)}`,
      });
    }
  }

  return events;
}

export const observableTurnEventsForTest = extractObservableTurnEvents;

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

function strictObjectSchema(
  properties: Record<string, Record<string, unknown>>,
): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: Object.keys(properties),
    properties,
  };
}

function nullableStringSchema(): Record<string, unknown> {
  return {
    type: ["string", "null"],
  };
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
  const artifactPath = result.report_path ?? result.handoff_report_path;
  await appendWatchEvent(projectRoot, {
    kind: "turn_completed",
    iteration,
    role,
    status: result.status,
    artifactPath,
    commitSha: result.commit_sha,
    message: `${capitalizeRole(role)} finished iteration ${iteration} with status ${result.status}: ${result.summary}`,
  });
}

async function appendWatchEventIfNew(
  projectRoot: string,
  event: WatchEventRecord,
  seenKeys: Set<string>,
): Promise<void> {
  const key = [
    event.kind,
    event.iteration ?? "",
    event.role ?? "",
    event.threadId ?? "",
    event.itemId ?? "",
    event.status ?? "",
    event.command ?? "",
    event.artifactPath ?? "",
    event.commitSha ?? "",
    event.message,
  ].join("|");
  if (seenKeys.has(key)) {
    return;
  }
  seenKeys.add(key);
  await appendWatchEvent(projectRoot, event);
}

async function appendWatchEvent(
  projectRoot: string,
  event: Omit<WatchEventRecord, "version" | "at"> & Partial<Pick<WatchEventRecord, "version" | "at">>,
): Promise<void> {
  const record: WatchEventRecord = {
    version: 1,
    at: new Date().toISOString(),
    ...event,
  };
  await fs.appendFile(
    await resolveWatchEventsPath(projectRoot),
    `${JSON.stringify(record)}\n`,
    "utf8",
  );
  const line = formatControllerLogLine(record);
  await fs.appendFile(await resolveControllerLogPath(projectRoot), line, "utf8");
}

function formatControllerLogLine(event: WatchEventRecord): string {
  const fields = [
    event.iteration ? `iter=${event.iteration}` : "",
    event.role ? `role=${event.role}` : "",
    `event=${event.kind}`,
    event.status ? `status=${event.status}` : "",
    event.artifactPath ? `artifact=${JSON.stringify(event.artifactPath)}` : "",
    event.commitSha ? `commit=${JSON.stringify(event.commitSha)}` : "",
    event.command ? `command=${JSON.stringify(event.command)}` : "",
    `message=${JSON.stringify(event.message)}`,
  ]
    .filter(Boolean)
    .join(" ");
  return `${event.at} ${fields}\n`;
}

function extractItemText(item: ThreadItemLike): string {
  if (item.text) {
    return item.text;
  }

  if (!item.content) {
    return "";
  }

  return item.content
    .map((entry) => entry.text ?? "")
    .filter(Boolean)
    .join("\n")
    .trim();
}

function previewOutput(text?: string): string | undefined {
  if (!text) {
    return undefined;
  }

  const normalized = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 4)
    .join(" | ");
  return normalized.length <= 320 ? normalized : `${normalized.slice(0, 317)}...`;
}

function shortCommand(command?: string): string {
  if (!command) {
    return "command";
  }

  return command.length <= 72 ? command : `${command.slice(0, 69)}...`;
}

function normalizeMessage(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function looksLikeJsonObject(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith("{") && trimmed.endsWith("}");
}

function capitalizeRole(role: RoleKind): string {
  return `${role.slice(0, 1).toUpperCase()}${role.slice(1)}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
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
