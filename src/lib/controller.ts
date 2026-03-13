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
import { buildManagedRoleInstructions, renderProjectCharter, summarizeRolePersona } from "./persona.js";
import {
  repoRootFromModule,
  specPath,
} from "./paths.js";
import {
  activeRolesForProject,
  ensureRoleAssigned,
  loadProjectConfig,
  loadRuntimeState,
  resolveArtifactsDir,
  resolveControllerLogPath,
  resolveProjectConfigPath,
  resolveWatchEventsPath,
  saveRuntimeState,
} from "./project.js";
import {
  builderRoleForLoopKind,
  roleTitle,
  verifierRoleForLoopKind,
  type ControllerTurnResult,
  type LoopStartInput,
  type ProjectConfig,
  type ReasoningSnapshot,
  type RoleKind,
  type RuntimeState,
  type WatchEventRecord,
} from "./types.js";

type ResolvedLoopStartInput = LoopStartInput & {
  startRole: RoleKind;
  task: string;
};

const CONNECTIVITY_GRACE_MS = 60 * 60 * 1000;
const CONNECTIVITY_RETRY_DELAY_MS = 30 * 1000;

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
    status: { type: "string", enum: ["goal_met", "needs_fix", "continue_monitoring", "blocked"] },
    use_passed: { type: "boolean" },
    summary: { type: "string" },
    report_path: { type: "string" },
    restart_performed: { type: "boolean" },
    restart_result: {
      type: "string",
      enum: ["not_configured", "performed", "already_running", "failed"],
    },
    monitor_result: {
      type: "string",
      enum: ["not_configured", "caveat_observed", "process_ended", "timeout_reached", "still_running"],
    },
    evidence_sufficient: { type: "boolean" },
    monitoring_evidence: { type: "string" },
    observed_caveat: nullableStringSchema(),
    issues: {
      type: "array",
      items: { type: "string" },
    },
    enhancement_targets: {
      type: "array",
      items: { type: "string" },
    },
    blocking_reason: nullableStringSchema(),
  }),
  scientist: strictObjectSchema({
    status: { type: "string", enum: ["goal_met", "needs_model_changes", "blocked"] },
    assessment_passed: { type: "boolean" },
    summary: { type: "string" },
    assessment_report_path: { type: "string" },
    issues: {
      type: "array",
      items: { type: "string" },
    },
    blocking_reason: nullableStringSchema(),
  }),
  modeller: strictObjectSchema({
    status: { type: "string", enum: ["model_ready", "blocked"] },
    design_ready: { type: "boolean" },
    summary: { type: "string" },
    model_report_path: { type: "string" },
    commit_sha: nullableStringSchema(),
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
  for (const role of activeRolesForProject(project)) {
    ensureRoleAssigned(runtime, role);
  }
  if (!activeRolesForProject(project).includes(input.startRole)) {
    throw new Error(
      `startRole ${input.startRole} is not active for ${project.loop_kind} projects`,
    );
  }

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
  let currentRole: RoleKind = input.startRole;

  try {
    await client.connect();
    await hydrateRoleThreads(repoRoot, client, project, runtime);

    for (let iteration = runtime.loop.iteration + 1; ; iteration += 1) {
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
      const hadConnectivityIssue = Boolean(runtime.loop.connectivityIssueSince);
      const result = await runRoleTurnWithConnectivityGrace(
        repoRoot,
        client,
        project,
        runtime,
        currentRole,
        iteration,
      );
      clearConnectivityIssue(runtime);
      if (hadConnectivityIssue) {
        await appendWatchEvent(project.project.root, {
          kind: "commentary",
          iteration,
          role: currentRole,
          status: "running",
          message: `${capitalizeRole(currentRole)} recovered from the connectivity outage and resumed normal work.`,
        });
      }
      const artifactPath = artifactPathFromResult(result);

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

      if (shouldKeepCurrentRole(project, currentRole, result)) {
        runtime.loop.status = "running";
        runtime.loop.lastError = undefined;
        runtime.loop.endedAt = undefined;
        await saveRuntimeState(runtime);
        await appendWatchEvent(project.project.root, {
          kind: "commentary",
          iteration,
          role: currentRole,
          status: "running",
          artifactPath,
          message: `${capitalizeRole(currentRole)} is keeping the baton and continuing live monitoring: ${result.summary}`,
        });
        continue;
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

      if (verifierReachedGoal(project, currentRole, result)) {
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

      currentRole = counterpartRole(project, currentRole);
    }
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
  for (const role of activeRolesForProject(project)) {
    await ensureRoleThreadReady(repoRoot, client, project, runtime, role);
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
  const roleSession = await ensureRoleThreadReady(repoRoot, client, project, runtime, role);
  const artifactDir = path.join(
    await resolveArtifactsDir(project.project.root),
    `iter-${String(iteration).padStart(3, "0")}`,
  );
  await ensureDir(artifactDir);
  const artifactPath = path.join(artifactDir, artifactFileNameForRole(role));
  const counterpartArtifact = await resolveCounterpartArtifact(project, runtime, role);

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
    await client.waitForTurnCompletion(roleSession.threadId, undefined, priorTurnCount);
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

  const parsed = await parseOrRecoverControllerTurnResult(
    project,
    role,
    lastTurn.items,
    artifactPath,
  );
  applyDefaultArtifactPath(role, parsed, artifactPath);
  if (isBuilderRole(project, role)) {
    parsed.commit_sha ??= await readHeadSha(project.project.root);
  }
  validateTurnResult(project, role, parsed);

  const finalArtifactPath = artifactPathFromResult(parsed);
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

async function ensureRoleThreadReady(
  repoRoot: string,
  client: CodexAppServerClient,
  project: ProjectConfig,
  runtime: RuntimeState,
  role: RoleKind,
) {
  const developerInstructions = await loadRoleInstructions(repoRoot, project, role);
  const assigned = runtime.roles[role];
  if (assigned) {
    try {
      await client.resumeThread({
        threadId: assigned.threadId,
        cwd: project.project.root,
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        developerInstructions,
        persistExtendedHistory: true,
      });
      await client.setThreadName(assigned.threadId, assigned.threadName);
      return assigned;
    } catch (error) {
      if (!isMissingRolloutError(error)) {
        throw error;
      }

      await appendWatchEvent(project.project.root, {
        kind: "commentary",
        role,
        status: runtime.loop.status,
        threadId: assigned.threadId,
        message: `${capitalizeRole(role)} assigned thread was no longer live. Creating a fresh managed session automatically.`,
      });
    }
  }

  const threadName = managedThreadName(project.project.id, role);
  const thread = await client.startThread({
    cwd: project.project.root,
    approvalPolicy: "never",
    sandbox: "danger-full-access",
    developerInstructions,
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
  return runtime.roles[role]!;
}

async function runRoleTurnWithConnectivityGrace(
  repoRoot: string,
  client: CodexAppServerClient,
  project: ProjectConfig,
  runtime: RuntimeState,
  role: RoleKind,
  iteration: number,
): Promise<ControllerTurnResult> {
  for (;;) {
    try {
      const result = await runRoleTurn(
        repoRoot,
        client,
        project,
        runtime,
        role,
        iteration,
      );
      const connectivityIssue = connectivityIssueFromTurnResult(result);
      if (!connectivityIssue) {
        return result;
      }

      const shouldRetry = await applyConnectivityGrace(
        project.project.root,
        runtime,
        role,
        iteration,
        connectivityIssue,
      );
      if (!shouldRetry) {
        return {
          ...result,
          status: "blocked",
          blocking_reason:
            result.blocking_reason ?? `Connectivity outage persisted beyond the one-hour grace window: ${connectivityIssue}`,
        };
      }
    } catch (error) {
      const connectivityIssue = connectivityIssueFromUnknown(error);
      if (!connectivityIssue) {
        throw error;
      }

      const shouldRetry = await applyConnectivityGrace(
        project.project.root,
        runtime,
        role,
        iteration,
        connectivityIssue,
      );
      if (!shouldRetry) {
        throw error;
      }
    }

    await delay(CONNECTIVITY_RETRY_DELAY_MS);
  }
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
  const roleInstructions = await loadRoleInstructions(repoRoot, project, role);
  const counterpartSummary =
    counterpartArtifact && (await pathExists(counterpartArtifact))
      ? await readTextIfExists(counterpartArtifact)
      : "No prior counterpart artifact is available.";
  const commandSections = renderRoleCommandSections(project, role);
  const projectConfig = await resolveProjectConfigPath(project.project.root);
  const specialization = project.roles[role]?.specialization?.trim() ?? "No additional specialization configured.";
  const personaSummary = summarizeRolePersona(project, role);
  const activePair = activeRolesForProject(project).map(roleTitle).join(" -> ");
  const counterpartRoleName = roleTitle(counterpartRole(project, role));
  const roleDescription = project.roles[role]?.description ?? `${roleTitle(role)} role`;

  return `${roleInstructions}

Project root: ${project.project.root}
Project spec: ${specPath(project.project.root)}
Project config: ${projectConfig}
Loop kind: ${project.loop_kind}
Active pair: ${activePair}
Iteration: ${iteration}
Managed branch: ${project.git.role_branch}
Goal:
${project.goal}

Project charter:
${renderProjectCharter(project)}

Role mission:
${roleDescription}

Project specialization for this role:
${specialization}

Generated persona for this role:
${personaSummary}

User-requested task for this loop:
${runtime.loop.task ?? "No explicit user task was recorded."}

Acceptance criteria:
${project.acceptance.map((item) => `- ${item}`).join("\n")}

Counterpart role:
${counterpartRoleName}

Operational commands and workflow for this role:
${commandSections}

Counterpart context:
${counterpartSummary}

Required artifact path: ${artifactPath}

During the turn, emit brief progress updates before or after major phases so the live monitor can track what you are doing.
Do not answer the human directly with markdown status notes or prose summaries. Put rich narrative into the artifact file, then end with the required JSON object only.
`;
}

async function loadRoleBaseInstructions(
  repoRoot: string,
  role: RoleKind,
): Promise<string> {
  const rolePath = path.join(repoRoot, "assets", "roles", `${role}.md`);
  return fs.readFile(rolePath, "utf8");
}

async function loadRoleInstructions(
  repoRoot: string,
  project: ProjectConfig,
  role: RoleKind,
): Promise<string> {
  const base = await loadRoleBaseInstructions(repoRoot, role);
  return buildManagedRoleInstructions(base, project, role);
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

function renderRoleCommandSections(project: ProjectConfig, role: RoleKind): string {
  const sections = [`Setup commands:\n${renderCommandList(project.commands.setup)}`];

  switch (role) {
    case "developer":
      sections.push(`Dry test commands:\n${renderCommandList(project.commands.dry_test)}`);
      break;
    case "debugger":
      sections.push(`Real use commands:\n${renderCommandList(project.commands.use)}`);
      sections.push(`Clean restart commands:\n${renderCommandList(project.commands.restart)}`);
      sections.push(`Monitor commands:\n${renderCommandList(project.commands.monitor)}`);
      sections.push(`Monitoring caveats:\n${renderBulletList(project.commands.monitor_until)}`);
      sections.push(
        `Monitoring timeout seconds:\n${
          project.commands.monitor_timeout_seconds == null
            ? "Unbounded"
            : String(project.commands.monitor_timeout_seconds)
        }`,
      );
      break;
    case "scientist":
      sections.push(
        `Scientist research commands:\n${renderCommandList(project.commands.scientist_research)}`,
      );
      sections.push(
        `Scientist assessment commands:\n${renderCommandList(project.commands.scientist_assess)}`,
      );
      break;
    case "modeller":
      sections.push(
        `Modeller design commands:\n${renderCommandList(project.commands.modeller_design)}`,
      );
      break;
  }

  return sections.join("\n\n");
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
      const rawText = extractItemText(item);
      const { snapshots, commentary } = extractReasoningSnapshots(rawText);
      for (const snapshot of snapshots) {
        events.push({
          version: 1,
          at: new Date().toISOString(),
          kind: "reasoning_snapshot",
          iteration,
          role,
          status: turn.status,
          threadId,
          itemId: item.id,
          itemType: item.type,
          reasoning: snapshot,
          message: formatReasoningSnapshotMessage(role, snapshot),
        });
      }

      const text = normalizeMessage(commentary);
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

function validateTurnResult(
  project: ProjectConfig,
  role: RoleKind,
  result: ControllerTurnResult,
): void {
  if (role === "developer") {
    if (result.status !== "blocked" && result.dry_test_passed !== true) {
      throw new Error("Developer turn did not confirm passing the configured dry tests");
    }
    return;
  }

  if (role === "modeller") {
    if (result.status !== "blocked" && result.design_ready !== true) {
      throw new Error("Modeller turn did not confirm the model/design was ready for assessment");
    }
    return;
  }

  if (role === "scientist") {
    validateScientistTurnResult(result);
    return;
  }

  validateDebuggerTurnResult(project, result);
}

function validateDebuggerTurnResult(project: ProjectConfig, result: ControllerTurnResult): void {
  const restartConfigured = (project.commands.restart?.length ?? 0) > 0;
  const monitoringConfigured =
    (project.commands.monitor?.length ?? 0) > 0 ||
    (project.commands.monitor_until?.length ?? 0) > 0;
  const continueMonitoring = result.status === "continue_monitoring";

  const restartHandled =
    result.restart_result === "performed" ||
    result.restart_result === "already_running" ||
    result.restart_performed === true;

  if (restartConfigured && result.status !== "blocked" && !restartHandled) {
    throw new Error("Debugger turn did not confirm handling the configured clean restart commands");
  }

  if (!restartConfigured && result.restart_result === "not_configured") {
    // valid explicit no-op
  } else if (
    restartConfigured &&
    result.restart_result &&
    !["performed", "already_running", "failed"].includes(result.restart_result)
  ) {
    throw new Error("Debugger turn reported an invalid restart_result for a configured restart contract");
  }

  if (result.restart_result === "performed" && result.restart_performed !== true) {
    throw new Error("Debugger turn reported restart_result=performed without restart_performed=true");
  }

  if (result.restart_result === "already_running" && result.restart_performed === true) {
    throw new Error("Debugger turn cannot report already_running together with restart_performed=true");
  }

  if (monitoringConfigured && result.monitor_result === "not_configured") {
    throw new Error("Debugger turn reported monitor_result=not_configured despite monitoring requirements");
  }

  if (continueMonitoring && result.monitor_result !== "still_running") {
    throw new Error("Debugger turn must report monitor_result=still_running when it keeps monitoring");
  }

  if (continueMonitoring && result.evidence_sufficient !== false) {
    throw new Error("Debugger turn must keep evidence_sufficient=false while monitoring is still in progress");
  }

  if (continueMonitoring && result.blocking_reason) {
    throw new Error("Debugger turn cannot report a blocking_reason when the live run is still progressing");
  }

  if (monitoringConfigured && result.status !== "blocked" && !continueMonitoring && result.evidence_sufficient !== true) {
    throw new Error("Debugger turn finished without enough monitoring evidence");
  }

  if (monitoringConfigured && result.status !== "blocked" && !result.monitoring_evidence?.trim()) {
    throw new Error("Debugger turn finished without monitoring_evidence");
  }

  if (result.monitor_result === "caveat_observed" && !result.observed_caveat) {
    throw new Error("Debugger turn reported caveat_observed without observed_caveat");
  }

  if (result.status === "needs_fix" && (result.issues?.length ?? 0) === 0) {
    throw new Error("Debugger turn reported needs_fix without concrete issues");
  }

  if (result.status === "needs_fix" && (result.enhancement_targets?.length ?? 0) === 0) {
    throw new Error("Debugger turn reported needs_fix without enhancement_targets");
  }

  if (result.status === "goal_met" && result.monitor_result === "caveat_observed") {
    throw new Error("Debugger turn cannot report goal_met when a monitoring caveat was observed");
  }
}

export const validateDebuggerTurnResultForTest = validateDebuggerTurnResult;

function shouldKeepCurrentRole(
  project: ProjectConfig,
  role: RoleKind,
  result: ControllerTurnResult,
): boolean {
  return project.loop_kind === "developer-debugger" && role === "debugger" && result.status === "continue_monitoring";
}

export const shouldKeepCurrentRoleForTest = shouldKeepCurrentRole;

function validateScientistTurnResult(result: ControllerTurnResult): void {
  if (result.status === "goal_met" && result.assessment_passed !== true) {
    throw new Error("Scientist turn cannot report goal_met without assessment_passed=true");
  }

  if (result.status === "needs_model_changes" && result.assessment_passed === true) {
    throw new Error("Scientist turn cannot mark assessment_passed=true when more model changes are required");
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

async function parseOrRecoverControllerTurnResult(
  project: ProjectConfig,
  role: RoleKind,
  items: ThreadItemLike[],
  artifactPath: string,
): Promise<ControllerTurnResult> {
  const agentMessages = [...items]
    .reverse()
    .map((item) => ({ item, text: extractItemText(item) }))
    .filter(
      (entry): entry is { item: ThreadItemLike; text: string } =>
        entry.item.type === "agentMessage" && entry.text.trim().length > 0,
    );

  if (agentMessages.length === 0) {
    throw new Error(`No final agent message found for ${role}`);
  }
  const latestAgentMessage = agentMessages[0]!;

  let lastParseError: unknown;
  for (const entry of agentMessages) {
    try {
      return parseControllerTurnResult(entry.text);
    } catch (error) {
      lastParseError = error;
    }
  }

  return recoverInvalidTurnResult(
    project,
    role,
    latestAgentMessage.text,
    artifactPath,
    lastParseError,
  );
}

async function recoverInvalidTurnResult(
  project: ProjectConfig,
  role: RoleKind,
  rawText: string,
  artifactPath: string,
  parseError: unknown,
): Promise<ControllerTurnResult> {
  const blockingReason =
    parseError instanceof Error
      ? parseError.message
      : `Role output is not valid JSON: ${rawText}`;
  const summary =
    `${capitalizeRole(role)} left the managed JSON contract. ` +
    `The raw final reply was saved to the iteration artifact and the turn was treated as blocked instead of failing the loop.`;
  const artifactBody = renderInvalidTurnArtifact(role, blockingReason, rawText);
  await ensureDir(path.dirname(artifactPath));
  await fs.writeFile(artifactPath, artifactBody, "utf8");

  switch (role) {
    case "developer":
      return {
        status: "blocked",
        dry_test_passed: false,
        summary,
        handoff_report_path: artifactPath,
        blocking_reason: blockingReason,
      };
    case "debugger":
      return {
        status: "blocked",
        use_passed: false,
        summary,
        report_path: artifactPath,
        restart_performed: false,
        restart_result: (project.commands.restart?.length ?? 0) > 0 ? "failed" : "not_configured",
        monitor_result: debuggerMonitoringFallback(project),
        evidence_sufficient: false,
        monitoring_evidence: normalizeMessage(rawText),
        observed_caveat: undefined,
        issues: [blockingReason],
        enhancement_targets: [],
        blocking_reason: blockingReason,
      };
    case "scientist":
      return {
        status: "blocked",
        assessment_passed: false,
        summary,
        assessment_report_path: artifactPath,
        issues: [blockingReason],
        enhancement_targets: [],
        blocking_reason: blockingReason,
      };
    case "modeller":
      return {
        status: "blocked",
        design_ready: false,
        summary,
        model_report_path: artifactPath,
        blocking_reason: blockingReason,
      };
  }
}

export const recoverInvalidTurnResultForTest = recoverInvalidTurnResult;

function debuggerMonitoringFallback(
  project: ProjectConfig,
): "not_configured" | "timeout_reached" {
  const monitoringConfigured =
    (project.commands.monitor?.length ?? 0) > 0 ||
    (project.commands.monitor_until?.length ?? 0) > 0;
  return monitoringConfigured ? "timeout_reached" : "not_configured";
}

function renderInvalidTurnArtifact(
  role: RoleKind,
  blockingReason: string,
  rawText: string,
): string {
  const cleaned = rawText.trim() || "(empty response)";
  return [
    `# ${capitalizeRole(role)} Invalid Final Reply`,
    "",
    "The managed turn did not end with the required JSON object.",
    "",
    `Blocking reason: ${blockingReason}`,
    "",
    "Raw final reply:",
    "",
    cleaned,
    "",
  ].join("\n");
}

function artifactFileNameForRole(role: RoleKind): string {
  switch (role) {
    case "developer":
      return "developer-handoff.md";
    case "debugger":
      return "debugger-report.md";
    case "scientist":
      return "scientist-assessment.md";
    case "modeller":
      return "modeller-design-report.md";
  }
}

function applyDefaultArtifactPath(
  role: RoleKind,
  result: ControllerTurnResult,
  artifactPath: string,
): void {
  switch (role) {
    case "developer":
      result.handoff_report_path ??= artifactPath;
      return;
    case "debugger":
      result.report_path ??= artifactPath;
      return;
    case "scientist":
      result.assessment_report_path ??= artifactPath;
      return;
    case "modeller":
      result.model_report_path ??= artifactPath;
      return;
  }
}

function artifactPathFromResult(result: ControllerTurnResult): string | undefined {
  return (
    result.report_path ??
    result.handoff_report_path ??
    result.model_report_path ??
    result.assessment_report_path
  );
}

async function resolveCounterpartArtifact(
  project: ProjectConfig,
  runtime: RuntimeState,
  role: RoleKind,
): Promise<string | undefined> {
  const counterpart = counterpartRole(project, role);
  const latestCounterpartRecord = [...runtime.history]
    .reverse()
    .find((record) => record.role === counterpart && record.artifactPath);
  const candidate = latestCounterpartRecord?.artifactPath;
  if (!candidate) {
    return undefined;
  }
  return (await pathExists(candidate)) ? candidate : undefined;
}

function counterpartRole(project: ProjectConfig, role: RoleKind): RoleKind {
  const [first, second] = activeRolesForProject(project);
  return role === first ? second : first;
}

async function applyConnectivityGrace(
  projectRoot: string,
  runtime: RuntimeState,
  role: RoleKind,
  iteration: number,
  issue: string,
): Promise<boolean> {
  const now = new Date();
  const existingStart = runtime.loop.connectivityIssueSince
    ? Date.parse(runtime.loop.connectivityIssueSince)
    : Number.NaN;
  const startedAt = Number.isFinite(existingStart) ? existingStart : now.getTime();
  const graceUntil = startedAt + CONNECTIVITY_GRACE_MS;
  runtime.loop.connectivityIssueSince = new Date(startedAt).toISOString();
  runtime.loop.connectivityGraceUntil = new Date(graceUntil).toISOString();
  runtime.loop.connectivityIssue = issue;
  runtime.loop.lastError = `Connectivity issue under grace until ${runtime.loop.connectivityGraceUntil}: ${issue}`;
  await saveRuntimeState(runtime);

  if (now.getTime() <= graceUntil) {
    await appendWatchEvent(projectRoot, {
      kind: "commentary",
      iteration,
      role,
      status: "running",
      message: `${capitalizeRole(role)} hit a transient connectivity issue and will keep retrying until ${runtime.loop.connectivityGraceUntil}: ${issue}`,
    });
    return true;
  }

  await appendWatchEvent(projectRoot, {
    kind: "commentary",
    iteration,
    role,
    status: "blocked",
    message: `${capitalizeRole(role)} exhausted the one-hour connectivity grace window: ${issue}`,
  });
  return false;
}

function clearConnectivityIssue(runtime: RuntimeState): void {
  if (!runtime.loop.connectivityIssueSince && !runtime.loop.connectivityIssue) {
    return;
  }

  runtime.loop.connectivityIssueSince = undefined;
  runtime.loop.connectivityGraceUntil = undefined;
  runtime.loop.connectivityIssue = undefined;
  if (runtime.loop.lastError?.startsWith("Connectivity issue under grace until ")) {
    runtime.loop.lastError = undefined;
  }
}

function connectivityIssueFromTurnResult(
  result: ControllerTurnResult,
): string | undefined {
  if (result.status !== "blocked") {
    return undefined;
  }

  return connectivityIssueFromTexts([
    result.blocking_reason,
    result.summary,
    ...(result.issues ?? []),
  ]);
}

function connectivityIssueFromUnknown(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message : String(error);
  return connectivityIssueFromTexts([message]);
}

function connectivityIssueFromTexts(values: Array<string | undefined>): string | undefined {
  const text = values
    .filter(Boolean)
    .join("\n")
    .trim();
  if (!text) {
    return undefined;
  }

  const patterns = [
    /\binternet\b/i,
    /\bnetwork\b/i,
    /\boffline\b/i,
    /\bdns\b/i,
    /\btemporary failure\b/i,
    /\bname resolution\b/i,
    /\bhost unreachable\b/i,
    /\bno route to host\b/i,
    /\bcould not resolve hostname\b/i,
    /\benotfound\b/i,
    /\beai_again\b/i,
    /\beconnreset\b/i,
    /\beconnrefused\b/i,
    /\bconnection (?:timed out|reset|refused|closed)\b/i,
    /\btls handshake timeout\b/i,
    /\bproxyconnect\b/i,
    /\bssh\b.*\b(unreachable|timed out|resolve|refused|reset)\b/i,
    /\bqsub\b.*\b(unreachable|timed out|refused|connection|resolve)\b/i,
    /\bweb\b.*\b(unreachable|timed out|offline)\b/i,
  ];

  return patterns.some((pattern) => pattern.test(text)) ? text.replace(/\s+/g, " ").trim() : undefined;
}

export const connectivityIssueFromTextsForTest = connectivityIssueFromTexts;

function isMissingRolloutError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    /no rollout found for thread id/i.test(message) ||
    /thread id .* not found/i.test(message) ||
    /thread .* not found/i.test(message)
  );
}

export const isMissingRolloutErrorForTest = isMissingRolloutError;

function isBuilderRole(project: ProjectConfig, role: RoleKind): boolean {
  return builderRoleForLoopKind(project.loop_kind) === role;
}

function verifierReachedGoal(
  project: ProjectConfig,
  role: RoleKind,
  result: ControllerTurnResult,
): boolean {
  if (verifierRoleForLoopKind(project.loop_kind) !== role || result.status !== "goal_met") {
    return false;
  }

  if (role === "scientist") {
    return result.assessment_passed === true;
  }

  return result.use_passed === true;
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
  return roleTitle(role);
}

const REASONING_SNAPSHOT_PREFIX = "REASONING-SNAPSHOT ";

function extractReasoningSnapshots(
  text: string,
): { snapshots: ReasoningSnapshot[]; commentary: string } {
  if (!text.trim()) {
    return { snapshots: [], commentary: "" };
  }

  const snapshots: ReasoningSnapshot[] = [];
  const commentaryLines: string[] = [];

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(REASONING_SNAPSHOT_PREFIX)) {
      commentaryLines.push(line);
      continue;
    }

    const snapshot = parseReasoningSnapshot(
      trimmed.slice(REASONING_SNAPSHOT_PREFIX.length).trim(),
    );
    if (snapshot) {
      snapshots.push(snapshot);
      continue;
    }

    commentaryLines.push(line);
  }

  return {
    snapshots,
    commentary: commentaryLines.join("\n"),
  };
}

function parseReasoningSnapshot(raw: string): ReasoningSnapshot | undefined {
  try {
    const parsed = JSON.parse(raw) as Partial<ReasoningSnapshot>;
    if (
      typeof parsed.intent !== "string" ||
      typeof parsed.current_step !== "string" ||
      typeof parsed.finding_or_risk !== "string" ||
      typeof parsed.next_action !== "string"
    ) {
      return undefined;
    }

    const snapshot: ReasoningSnapshot = {
      intent: parsed.intent.trim(),
      current_step: parsed.current_step.trim(),
      finding_or_risk: parsed.finding_or_risk.trim(),
      next_action: parsed.next_action.trim(),
    };
    if (
      !snapshot.intent ||
      !snapshot.current_step ||
      !snapshot.finding_or_risk ||
      !snapshot.next_action
    ) {
      return undefined;
    }
    if (typeof parsed.blocker === "string" && parsed.blocker.trim()) {
      snapshot.blocker = parsed.blocker.trim();
    }
    return snapshot;
  } catch {
    return undefined;
  }
}

function formatReasoningSnapshotMessage(
  role: RoleKind,
  snapshot: ReasoningSnapshot,
): string {
  const blocker = snapshot.blocker?.trim()
    ? ` blocker: ${snapshot.blocker.trim()}`
    : "";
  return `${capitalizeRole(role)} reasoning: ${snapshot.current_step.trim()} | ${snapshot.finding_or_risk.trim()} | next: ${snapshot.next_action.trim()}${blocker}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function validateRunnableProject(project: ProjectConfig): void {
  const commandBuckets =
    project.loop_kind === "scientist-modeller"
      ? [
          ...(project.commands.scientist_research ?? []),
          ...(project.commands.modeller_design ?? []),
          ...(project.commands.scientist_assess ?? []),
        ]
      : [...(project.commands.dry_test ?? []), ...(project.commands.use ?? [])];
  const placeholders = commandBuckets.filter((command) => command.includes("Set commands."));
  if (placeholders.length > 0) {
    throw new Error(
      `Project ${project.project.id} still contains placeholder commands in .devise/project.yaml`,
    );
  }
}

function failMissingPid(projectId: string): never {
  throw new Error(`Failed to spawn controller for project ${projectId}: missing pid`);
}
