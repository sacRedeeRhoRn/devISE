import path from "node:path";
import readline from "node:readline";

import { readTextIfExists } from "./fs.js";
import { resolveControllerLogPath } from "./project.js";
import type { RoleService } from "./service.js";
import type { IterationRecord, RoleKind, RuntimeState } from "./types.js";

const RESET = "\u001b[0m";
const BOLD = "\u001b[1m";
const DIM = "\u001b[2m";
const DEVELOPER = "\u001b[38;5;214m";
const DEBUGGER = "\u001b[38;5;81m";
const OK = "\u001b[38;5;42m";
const WARN = "\u001b[38;5;220m";
const ERR = "\u001b[38;5;203m";
const MUTED = "\u001b[38;5;246m";

interface MonitorSnapshot {
  projectId: string;
  projectRoot: string;
  runtime: RuntimeState;
  controllerAlive: boolean;
  controllerTail: string[];
  developerRecord?: IterationRecord;
  debuggerRecord?: IterationRecord;
  developerPreview: string[];
  debuggerPreview: string[];
}

export async function startWatch(
  service: RoleService,
  selector: string,
): Promise<void> {
  const initialStatus = await service.getStatus(selector);
  const projectRoot = initialStatus.project.project.root;
  const controllerLog = await resolveControllerLogPath(projectRoot);

  if (!process.stdout.isTTY) {
    const snapshot = await buildSnapshot(initialStatus.runtime, initialStatus.controllerAlive, controllerLog);
    process.stdout.write(renderDashboard(snapshot, 100, 40, false));
    return;
  }

  let closed = false;
  const cleanupCallbacks: Array<() => void> = [];

  const cleanup = (): void => {
    if (closed) {
      return;
    }
    closed = true;
    for (const callback of cleanupCallbacks.reverse()) {
      callback();
    }
    process.stdout.write(`\u001b[?25h${RESET}`);
  };

  const redraw = async (): Promise<void> => {
    const status = await service.getStatus(selector);
    const snapshot = await buildSnapshot(status.runtime, status.controllerAlive, controllerLog);
    process.stdout.write("\u001b[2J\u001b[H\u001b[?25l");
    process.stdout.write(
      renderDashboard(
        snapshot,
        Math.max(process.stdout.columns || 120, 80),
        Math.max(process.stdout.rows || 40, 24),
        true,
      ),
    );
  };

  const interval = setInterval(() => {
    void redraw().catch((error) => {
      process.stdout.write(`\u001b[2J\u001b[H${ERR}${String(error)}${RESET}\n`);
    });
  }, 1000);
  cleanupCallbacks.push(() => clearInterval(interval));

  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    cleanupCallbacks.push(() => process.stdin.setRawMode(false));
  }

  const onKeypress = (_: string, key: readline.Key): void => {
    if (key.name === "q" || key.name === "escape" || (key.ctrl && key.name === "c")) {
      cleanup();
    }
  };
  process.stdin.on("keypress", onKeypress);
  cleanupCallbacks.push(() => process.stdin.off("keypress", onKeypress));

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
  cleanupCallbacks.push(() => process.off("SIGINT", cleanup));
  cleanupCallbacks.push(() => process.off("SIGTERM", cleanup));

  await redraw();

  await new Promise<void>((resolve) => {
    const waitForExit = (): void => {
      if (closed) {
        resolve();
        return;
      }
      setTimeout(waitForExit, 100);
    };
    waitForExit();
  });
}

async function buildSnapshot(
  runtime: RuntimeState,
  controllerAlive: boolean,
  controllerLogPath: string,
): Promise<MonitorSnapshot> {
  const developerRecord = findLatestRecord(runtime, "developer");
  const debuggerRecord = findLatestRecord(runtime, "debugger");
  const developerPreview = await readArtifactPreview(developerRecord?.artifactPath);
  const debuggerPreview = await readArtifactPreview(debuggerRecord?.artifactPath);
  const controllerTail = tailLines(await readTextIfExists(controllerLogPath), 12);

  return {
    projectId: runtime.projectId,
    projectRoot: runtime.projectRoot,
    runtime,
    controllerAlive,
    controllerTail,
    developerRecord,
    debuggerRecord,
    developerPreview,
    debuggerPreview,
  };
}

function renderDashboard(
  snapshot: MonitorSnapshot,
  width: number,
  height: number,
  color: boolean,
): string {
  const activeRole =
    snapshot.runtime.loop.status === "running"
      ? snapshot.runtime.loop.lastRole ?? snapshot.runtime.loop.startRole ?? "none"
      : snapshot.runtime.loop.lastRole ?? "none";
  const lines: string[] = [];
  const tone = statusTone(snapshot.runtime.loop.status, color);
  const header = `${tone}${BOLD}devISE watch${RESET}${tone}  ${snapshot.projectId}${RESET}`;
  const statusLine =
    `${label("loop", snapshot.runtime.loop.status, tone, color)}  ` +
    `${label("iter", String(snapshot.runtime.loop.iteration), MUTED, color)}  ` +
    `${label("active", activeRole, roleTone(activeRole as RoleKind | "none", color), color)}  ` +
    `${label("controller", snapshot.controllerAlive ? "alive" : "stopped", snapshot.controllerAlive ? OK : ERR, color)}`;
  const rootLine = `${dimIf(color, "root")}: ${snapshot.projectRoot}`;
  const taskLine = `${dimIf(color, "task")}: ${snapshot.runtime.loop.task ?? snapshot.runtime.launch.stagedTask ?? "none"}`;
  const noteLine = `${DIM}Observable output only. Hidden model chain-of-thought is not available. Press q to exit.${RESET}`;

  lines.push(header);
  lines.push(statusLine);
  lines.push(rootLine);
  lines.push(taskLine);
  lines.push(noteLine);
  lines.push("");

  const columnWidth = width >= 120 ? Math.floor((width - 3) / 2) : width;
  const developerCard = renderRoleCard(
    "Developer lane",
    snapshot.runtime,
    "developer",
    snapshot.developerRecord,
    snapshot.developerPreview,
    columnWidth,
    color,
  );
  const debuggerCard = renderRoleCard(
    "Debugger lane",
    snapshot.runtime,
    "debugger",
    snapshot.debuggerRecord,
    snapshot.debuggerPreview,
    columnWidth,
    color,
  );

  if (width >= 120) {
    const maxLines = Math.max(developerCard.length, debuggerCard.length);
    for (let index = 0; index < maxLines; index += 1) {
      const left = developerCard[index] ?? " ".repeat(columnWidth);
      const right = debuggerCard[index] ?? " ".repeat(columnWidth);
      lines.push(`${left} ${MUTED}|${RESET} ${right}`);
    }
  } else {
    lines.push(...developerCard, "", ...debuggerCard);
  }

  lines.push("");

  const feedHeight = Math.max(height - lines.length - 2, 6);
  lines.push(...renderFeedCard(snapshot.controllerTail, width, feedHeight, color));

  return `${lines.slice(0, height - 1).join("\n")}\n`;
}

function renderRoleCard(
  title: string,
  runtime: RuntimeState,
  role: RoleKind,
  record: IterationRecord | undefined,
  preview: string[],
  width: number,
  color: boolean,
): string[] {
  const tone = roleTone(role, color);
  const session = runtime.roles[role];
  const artifact = record?.artifactPath ? path.basename(record.artifactPath) : "none";
  const summary = record?.summary ?? "No completed iteration yet.";
  const body = [
    `${dimIf(color, "thread")}: ${session?.threadId ?? "unassigned"}`,
    `${dimIf(color, "latest")}: ${record ? `iter ${record.iteration} ${record.status}` : "none"}`,
    `${dimIf(color, "artifact")}: ${artifact}`,
    `${dimIf(color, "summary")}: ${summary}`,
    "",
    `${dimIf(color, "preview")}:`,
    ...(preview.length > 0 ? preview : ["(no artifact preview yet)"]),
  ];
  return renderCard(title, body, width, tone);
}

function renderFeedCard(lines: string[], width: number, height: number, color: boolean): string[] {
  const tone = color ? MUTED : "";
  const content = lines.length > 0 ? lines : ["(controller log is empty)"];
  return renderCard("Controller feed", content, width, tone, height);
}

function renderCard(
  title: string,
  lines: string[],
  width: number,
  tone: string,
  maxLines?: number,
): string[] {
  const safeWidth = Math.max(width, 48);
  const innerWidth = safeWidth - 4;
  const top = `${tone}+${"-".repeat(safeWidth - 2)}+${RESET}`;
  const titleLine = padCardLine(`${BOLD}${title}${RESET}`, innerWidth);
  const wrapped = lines.flatMap((line) => wrapLine(line, innerWidth));
  const limited = typeof maxLines === "number" ? wrapped.slice(0, Math.max(maxLines - 3, 1)) : wrapped;
  const rendered = [
    top,
    `${tone}| ${titleLine} |${RESET}`,
    top,
    ...limited.map((line) => `${tone}| ${padCardLine(line, innerWidth)} |${RESET}`),
    top,
  ];

  return rendered;
}

function padCardLine(text: string, width: number): string {
  const visible = visibleLength(text);
  if (visible >= width) {
    return truncateVisible(text, width);
  }
  return `${text}${" ".repeat(width - visible)}`;
}

function wrapLine(input: string, width: number): string[] {
  if (input.length === 0) {
    return [""];
  }

  const words = input.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const next = current.length === 0 ? word : `${current} ${word}`;
    if (visibleLength(next) <= width) {
      current = next;
      continue;
    }
    if (current.length > 0) {
      lines.push(current);
      current = word;
      continue;
    }
    lines.push(word.slice(0, width));
    current = word.slice(width);
  }
  if (current.length > 0) {
    lines.push(current);
  }
  return lines;
}

function truncateVisible(text: string, width: number): string {
  if (visibleLength(text) <= width) {
    return text;
  }

  let output = "";
  let visible = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\u001b") {
      const end = text.indexOf("m", index);
      if (end >= 0) {
        output += text.slice(index, end + 1);
        index = end;
        continue;
      }
    }
    if (visible >= width - 1) {
      break;
    }
    output += text[index];
    visible += 1;
  }
  return `${output}…`;
}

function visibleLength(text: string): number {
  return text.replace(/\u001b\[[0-9;]*m/g, "").length;
}

function tailLines(text: string, count: number): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .slice(-count);
}

async function readArtifactPreview(artifactPath?: string): Promise<string[]> {
  if (!artifactPath) {
    return [];
  }
  const raw = await readTextIfExists(artifactPath);
  return raw
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .slice(0, 12);
}

function findLatestRecord(runtime: RuntimeState, role: RoleKind): IterationRecord | undefined {
  return [...runtime.history].reverse().find((record) => record.role === role);
}

function roleTone(role: RoleKind | "none", color: boolean): string {
  if (!color) {
    return "";
  }
  return role === "developer" ? DEVELOPER : role === "debugger" ? DEBUGGER : MUTED;
}

function statusTone(status: string, color: boolean): string {
  if (!color) {
    return "";
  }
  if (status === "completed") {
    return OK;
  }
  if (status === "running") {
    return DEBUGGER;
  }
  if (status === "blocked" || status === "failed" || status === "orphaned") {
    return ERR;
  }
  if (status === "stopped") {
    return WARN;
  }
  return MUTED;
}

function label(name: string, value: string, tone: string, color: boolean): string {
  if (!color) {
    return `${name}=${value}`;
  }
  return `${DIM}${name}${RESET}=${tone}${BOLD}${value}${RESET}`;
}

function dimIf(color: boolean, value: string): string {
  return color ? `${DIM}${value}${RESET}` : value;
}
