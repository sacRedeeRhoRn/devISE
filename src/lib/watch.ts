import path from "node:path";

import blessed from "blessed";

import { readTextIfExists } from "./fs.js";
import { resolveControllerLogPath, resolveWatchEventsPath } from "./project.js";
import type { RoleService } from "./service.js";
import type { IterationRecord, RoleKind, RuntimeState, WatchEventRecord } from "./types.js";

type PaneMode = "timeline" | "feed" | "developer" | "debugger";
type Tone = "developer" | "debugger" | "ok" | "warn" | "err" | "muted";

interface MonitorSnapshot {
  projectId: string;
  projectRoot: string;
  runtime: RuntimeState;
  controllerAlive: boolean;
  events: WatchEventRecord[];
  developerRecord?: IterationRecord;
  debuggerRecord?: IterationRecord;
  developerPreview: string[];
  debuggerPreview: string[];
}

interface WatchTimelineEntry {
  key: string;
  label: string;
  detail: string;
  tone: Tone;
}

interface WatchFeedItem {
  key: string;
  label: string;
  detail: string;
  tone: Tone;
}

interface WatchRolePanel {
  role: RoleKind;
  title: string;
  tone: Tone;
  threadId: string;
  latestLabel: string;
  artifactName: string;
  commitSha: string;
  summary: string;
  preview: string[];
  detail: string;
}

interface WatchModel {
  projectId: string;
  projectRoot: string;
  loopStatus: string;
  iteration: number;
  controllerAlive: boolean;
  task: string;
  activeRole: RoleKind | "none";
  headerNote: string;
  timeline: WatchTimelineEntry[];
  feed: WatchFeedItem[];
  roles: Record<RoleKind, WatchRolePanel>;
}

interface WatchUi {
  screen: blessed.Widgets.Screen;
  header: blessed.Widgets.BoxElement;
  timeline: blessed.Widgets.ListElement;
  feed: blessed.Widgets.ListElement;
  inspector: blessed.Widgets.BoxElement;
  developerBox: blessed.Widgets.BoxElement;
  debuggerBox: blessed.Widgets.BoxElement;
  detail: blessed.Widgets.BoxElement;
  help: blessed.Widgets.BoxElement;
}

interface WatchState {
  pane: PaneMode;
  feedIndex: number;
  timelineIndex: number;
  helpOpen: boolean;
}

const THEME = {
  bg: "#111111",
  panel: "#1b1816",
  panelAlt: "#201c19",
  border: "#53463f",
  text: "#f3eadf",
  muted: "#aa9c8e",
  developer: "#d9a15d",
  debugger: "#7db8c9",
  ok: "#7bc67e",
  warn: "#d7b06d",
  err: "#d97b70",
  accent: "#f7efe5",
  shadow: "#0d0d0d",
};

const SPINNER = ["●", "◐", "●", "◑"];

export async function startWatch(
  service: RoleService,
  selector: string,
): Promise<void> {
  const initialStatus = await service.getStatus(selector);
  const projectRoot = initialStatus.project.project.root;
  const controllerLogPath = await resolveControllerLogPath(projectRoot);
  const watchEventsPath = await resolveWatchEventsPath(projectRoot);

  if (!process.stdout.isTTY) {
    const snapshot = await buildSnapshot(
      initialStatus.runtime,
      initialStatus.controllerAlive,
      watchEventsPath,
      controllerLogPath,
    );
    const model = buildWatchModel(snapshot, 0);
    process.stdout.write(renderPlainSnapshot(model));
    return;
  }

  const ui = createUi();
  const state: WatchState = {
    pane: "feed",
    feedIndex: 0,
    timelineIndex: 0,
    helpOpen: false,
  };
  let spinnerIndex = 0;
  let closed = false;
  let currentModel = buildWatchModel(
    await buildSnapshot(
      initialStatus.runtime,
      initialStatus.controllerAlive,
      watchEventsPath,
      controllerLogPath,
    ),
    spinnerIndex,
  );

  const redrawCurrent = (): void => {
    renderUi(ui, currentModel, state);
  };

  const refresh = async (): Promise<void> => {
    const status = await service.getStatus(selector);
    const snapshot = await buildSnapshot(
      status.runtime,
      status.controllerAlive,
      watchEventsPath,
      controllerLogPath,
    );
    const model = buildWatchModel(snapshot, spinnerIndex);
    spinnerIndex = (spinnerIndex + 1) % SPINNER.length;
    currentModel = model;
    redrawCurrent();
  };

  const close = (): void => {
    if (closed) {
      return;
    }
    closed = true;
    ui.screen.destroy();
  };

  ui.screen.key(["q", "escape", "C-c"], close);
  ui.screen.key(["tab"], () => {
    state.pane = nextPane(state.pane);
    redrawCurrent();
  });
  ui.screen.key(["S-tab"], () => {
    state.pane = previousPane(state.pane);
    redrawCurrent();
  });
  ui.screen.key(["0"], () => {
    state.pane = "feed";
    redrawCurrent();
  });
  ui.screen.key(["1"], () => {
    state.pane = "developer";
    redrawCurrent();
  });
  ui.screen.key(["2"], () => {
    state.pane = "debugger";
    redrawCurrent();
  });
  ui.screen.key(["r"], () => {
    void refresh();
  });
  ui.screen.key(["?"], () => {
    state.helpOpen = !state.helpOpen;
    ui.help.hidden = !state.helpOpen;
    ui.screen.render();
  });
  ui.screen.key(["up", "k"], () => {
    if (state.pane === "timeline") {
      state.timelineIndex = Math.max(state.timelineIndex - 1, 0);
      redrawCurrent();
    } else if (state.pane === "feed") {
      state.feedIndex = Math.max(state.feedIndex - 1, 0);
      redrawCurrent();
    } else {
      ui.detail.scroll(-1);
      ui.screen.render();
    }
  });
  ui.screen.key(["down", "j"], () => {
    if (state.pane === "timeline") {
      state.timelineIndex += 1;
      redrawCurrent();
    } else if (state.pane === "feed") {
      state.feedIndex += 1;
      redrawCurrent();
    } else {
      ui.detail.scroll(1);
      ui.screen.render();
    }
  });
  ui.screen.key(["pageup"], () => {
    ui.detail.scroll(-6);
    ui.screen.render();
  });
  ui.screen.key(["pagedown"], () => {
    ui.detail.scroll(6);
    ui.screen.render();
  });

  const interval = setInterval(() => {
    void refresh().catch((error) => {
      ui.detail.setContent(`{red-fg}${escapeTags(String(error))}{/red-fg}`);
      ui.screen.render();
    });
  }, 1000);
  ui.screen.once("destroy", () => clearInterval(interval));

  redrawCurrent();
  await refresh();
  await new Promise<void>((resolve) => {
    ui.screen.once("destroy", resolve);
  });
}

export async function buildSnapshot(
  runtime: RuntimeState,
  controllerAlive: boolean,
  watchEventsPath: string,
  controllerLogPath: string,
): Promise<MonitorSnapshot> {
  const watchEventText = await readTextIfExists(watchEventsPath);
  const controllerLogText = await readTextIfExists(controllerLogPath);
  const parsedEvents = parseWatchEventsText(watchEventText);
  const events = parsedEvents.length > 0 ? parsedEvents : parseControllerLogFallback(controllerLogText);
  const developerRecord = findLatestRecord(runtime, "developer");
  const debuggerRecord = findLatestRecord(runtime, "debugger");

  return {
    projectId: runtime.projectId,
    projectRoot: runtime.projectRoot,
    runtime,
    controllerAlive,
    events,
    developerRecord,
    debuggerRecord,
    developerPreview: await readArtifactPreview(developerRecord?.artifactPath),
    debuggerPreview: await readArtifactPreview(debuggerRecord?.artifactPath),
  };
}

export function parseWatchEventsText(text: string): WatchEventRecord[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as WatchEventRecord];
      } catch {
        return [];
      }
    })
    .sort((left, right) => left.at.localeCompare(right.at));
}

export function parseControllerLogFallback(text: string): WatchEventRecord[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [stamp, ...rest] = line.split(" ");
      const role = line.includes("role=developer")
        ? "developer"
        : line.includes("role=debugger")
          ? "debugger"
          : undefined;
      const kind = line.includes("event=turn_completed")
        ? "turn_completed"
        : line.includes("event=turn_started")
          ? "turn_started"
          : line.includes("event=loop_completed")
            ? "loop_completed"
            : line.includes("event=loop_blocked")
              ? "loop_blocked"
              : line.includes("event=loop_failed")
                ? "loop_failed"
                : "commentary";
      return {
        version: 1,
        at: stamp ?? new Date().toISOString(),
        kind,
        role,
        message: rest.join(" "),
      } as WatchEventRecord;
    });
}

export function buildWatchModel(snapshot: MonitorSnapshot, spinnerIndex: number): WatchModel {
  const activeRole =
    snapshot.runtime.loop.status === "running"
      ? snapshot.runtime.loop.lastRole ?? snapshot.runtime.loop.startRole ?? "none"
      : snapshot.runtime.loop.lastRole ?? "none";
  const timeline = buildTimeline(snapshot.runtime, activeRole);
  const feed = buildFeed(snapshot.events);
  const roles = {
    developer: buildRolePanel(snapshot.runtime, snapshot.developerRecord, snapshot.developerPreview, "developer"),
    debugger: buildRolePanel(snapshot.runtime, snapshot.debuggerRecord, snapshot.debuggerPreview, "debugger"),
  };
  const activity =
    snapshot.runtime.loop.status === "running"
      ? `${SPINNER[spinnerIndex]} ${capitalizeRole(activeRole === "none" ? "developer" : activeRole)} in motion`
      : "Observable output only. Hidden chain-of-thought is not available.";

  return {
    projectId: snapshot.projectId,
    projectRoot: snapshot.projectRoot,
    loopStatus: snapshot.runtime.loop.status,
    iteration: snapshot.runtime.loop.iteration,
    controllerAlive: snapshot.controllerAlive,
    task: snapshot.runtime.loop.task ?? snapshot.runtime.launch.stagedTask ?? "No task recorded.",
    activeRole,
    headerNote: activity,
    timeline,
    feed,
    roles,
  };
}

function createUi(): WatchUi {
  const screen = blessed.screen({
    smartCSR: true,
    title: "devISE watch",
    dockBorders: true,
    fullUnicode: true,
    autoPadding: false,
  });

  const header = blessed.box({
    parent: screen,
    top: 0,
    left: 0,
    right: 0,
    height: 5,
    tags: true,
    style: { bg: THEME.bg, fg: THEME.text },
  });

  const timeline = blessed.list({
    parent: screen,
    top: 5,
    left: 0,
    bottom: 9,
    width: "23%",
    border: "line",
    label: " Timeline ",
    tags: true,
    keys: false,
    mouse: false,
    style: {
      bg: THEME.panel,
      fg: THEME.text,
      border: { fg: THEME.border },
      selected: { bg: THEME.panelAlt, fg: THEME.accent, bold: true },
      item: { fg: THEME.text },
    },
    scrollbar: {
      ch: " ",
      track: { bg: THEME.shadow },
      style: { bg: THEME.border },
    },
  });

  const feed = blessed.list({
    parent: screen,
    top: 5,
    left: "23%",
    width: "45%",
    bottom: 9,
    border: "line",
    label: " Live Feed ",
    tags: true,
    keys: false,
    mouse: false,
    style: {
      bg: THEME.panel,
      fg: THEME.text,
      border: { fg: THEME.border },
      selected: { bg: THEME.panelAlt, fg: THEME.accent, bold: true },
      item: { fg: THEME.text },
    },
    scrollbar: {
      ch: " ",
      track: { bg: THEME.shadow },
      style: { bg: THEME.border },
    },
  });

  const inspector = blessed.box({
    parent: screen,
    top: 5,
    right: 0,
    width: "32%",
    bottom: 9,
    border: "line",
    label: " Role Snapshot ",
    tags: true,
    style: {
      bg: THEME.panel,
      fg: THEME.text,
      border: { fg: THEME.border },
    },
  });

  const developerBox = blessed.box({
    parent: inspector,
    top: 0,
    left: 0,
    right: 0,
    height: "50%",
    border: "line",
    label: " Developer ",
    tags: true,
    scrollable: true,
    alwaysScroll: true,
    style: {
      bg: THEME.panel,
      fg: THEME.text,
      border: { fg: THEME.developer },
    },
    scrollbar: {
      ch: " ",
      track: { bg: THEME.shadow },
      style: { bg: THEME.developer },
    },
  });

  const debuggerBox = blessed.box({
    parent: inspector,
    top: "50%",
    left: 0,
    right: 0,
    bottom: 0,
    border: "line",
    label: " Debugger ",
    tags: true,
    scrollable: true,
    alwaysScroll: true,
    style: {
      bg: THEME.panel,
      fg: THEME.text,
      border: { fg: THEME.debugger },
    },
    scrollbar: {
      ch: " ",
      track: { bg: THEME.shadow },
      style: { bg: THEME.debugger },
    },
  });

  const detail = blessed.box({
    parent: screen,
    left: 0,
    right: 0,
    bottom: 0,
    height: 9,
    border: "line",
    label: " Detail ",
    tags: true,
    scrollable: true,
    alwaysScroll: true,
    style: {
      bg: THEME.panelAlt,
      fg: THEME.text,
      border: { fg: THEME.border },
    },
    scrollbar: {
      ch: " ",
      track: { bg: THEME.shadow },
      style: { bg: THEME.muted },
    },
  });

  const help = blessed.box({
    parent: screen,
    width: "54%",
    height: 10,
    top: "center",
    left: "center",
    border: "line",
    label: " Shortcuts ",
    tags: true,
    hidden: true,
    style: {
      bg: THEME.panelAlt,
      fg: THEME.text,
      border: { fg: THEME.warn },
    },
    content: [
      "{bold}q{/bold} quit",
      "{bold}Tab{/bold} cycle focus between timeline, feed, developer, debugger",
      "{bold}0{/bold} focus live feed",
      "{bold}1{/bold} focus developer lane",
      "{bold}2{/bold} focus debugger lane",
      "{bold}↑ ↓{/bold} or {bold}j k{/bold} move selection or scroll detail",
      "{bold}PgUp PgDn{/bold} scroll detail",
      "{bold}r{/bold} refresh immediately",
      "{bold}?{/bold} toggle this help",
    ].join("\n"),
  });

  return {
    screen,
    header,
    timeline,
    feed,
    inspector,
    developerBox,
    debuggerBox,
    detail,
    help,
  };
}

function renderUi(ui: WatchUi, model: WatchModel, state: WatchState): void {
  state.feedIndex = clampIndex(state.feedIndex, model.feed.length);
  state.timelineIndex = clampIndex(state.timelineIndex, model.timeline.length);

  ui.header.setContent(renderHeader(model));
  ui.timeline.setItems(model.timeline.map((entry) => entry.label));
  ui.feed.setItems(model.feed.map((entry) => entry.label));
  ui.timeline.select(state.timelineIndex);
  ui.feed.select(state.feedIndex);

  ui.developerBox.setContent(renderRolePanel(model.roles.developer));
  ui.debuggerBox.setContent(renderRolePanel(model.roles.debugger));

  ui.detail.setContent(renderDetail(model, state));
  ui.detail.setScrollPerc(0);

  setPaneStyles(ui, state);
  ui.screen.render();
}

function renderHeader(model: WatchModel): string {
  const statusTone = toneTag(statusToneOf(model.loopStatus));
  const activeTone = toneTag(model.activeRole === "developer" ? "developer" : model.activeRole === "debugger" ? "debugger" : "muted");
  const controllerTone = toneTag(model.controllerAlive ? "ok" : "err");

  return [
    `${statusTone}{bold}devISE watch{/bold}{/} {white-fg}${escapeTags(model.projectId)}{/white-fg}`,
    `${dim("loop")} ${statusTone}{bold}${escapeTags(model.loopStatus)}{/bold}{/}   ` +
      `${dim("iter")} {white-fg}${model.iteration}{/white-fg}   ` +
      `${dim("active")} ${activeTone}{bold}${escapeTags(model.activeRole)}{/bold}{/}   ` +
      `${dim("controller")} ${controllerTone}{bold}${model.controllerAlive ? "alive" : "stopped"}{/bold}{/}`,
    `${dim("root")} ${escapeTags(model.projectRoot)}`,
    `${dim("task")} ${escapeTags(model.task)}\n${dim("note")} ${escapeTags(model.headerNote)}`,
  ].join("\n");
}

function renderRolePanel(panel: WatchRolePanel): string {
  const tone = toneTag(panel.tone);
  return [
    `${dim("thread")} ${escapeTags(panel.threadId)}`,
    `${dim("latest")} ${tone}{bold}${escapeTags(panel.latestLabel)}{/bold}{/}`,
    `${dim("artifact")} ${escapeTags(panel.artifactName)}`,
    `${dim("commit")} ${escapeTags(panel.commitSha)}`,
    "",
    `{bold}Summary{/bold}`,
    escapeTags(panel.summary),
    "",
    `{bold}Preview{/bold}`,
    ...panel.preview.map((line) => escapeTags(line)),
  ].join("\n");
}

function renderDetail(model: WatchModel, state: WatchState): string {
  if (state.pane === "developer") {
    return model.roles.developer.detail;
  }
  if (state.pane === "debugger") {
    return model.roles.debugger.detail;
  }
  if (state.pane === "timeline") {
    return model.timeline[state.timelineIndex]?.detail ?? "No timeline entry selected.";
  }
  return model.feed[state.feedIndex]?.detail ?? "No live feed item selected.";
}

function setPaneStyles(ui: WatchUi, state: WatchState): void {
  ui.timeline.style.border.fg = state.pane === "timeline" ? THEME.warn : THEME.border;
  ui.feed.style.border.fg = state.pane === "feed" ? THEME.warn : THEME.border;
  ui.developerBox.style.border.fg = state.pane === "developer" ? THEME.accent : THEME.developer;
  ui.debuggerBox.style.border.fg = state.pane === "debugger" ? THEME.accent : THEME.debugger;
  ui.detail.style.border.fg = THEME.warn;
}

function buildTimeline(runtime: RuntimeState, activeRole: RoleKind | "none"): WatchTimelineEntry[] {
  const items = runtime.history.map((record) => {
    const tone = statusToneOf(record.status);
    return {
      key: `${record.iteration}-${record.role}`,
      label:
        `${toneTag(tone)}${String(record.iteration).padStart(2, "0")}{/} ` +
        `${roleBadge(record.role)} ${statusTag(record.status)} ` +
        `${escapeTags(truncate(record.summary, 48))}`,
      detail: [
        `{bold}Iteration ${record.iteration}{/bold}`,
        `${dim("role")} ${escapeTags(record.role)}`,
        `${dim("status")} ${escapeTags(record.status)}`,
        `${dim("artifact")} ${escapeTags(record.artifactPath ?? "none")}`,
        `${dim("commit")} ${escapeTags(record.commitSha ?? "none")}`,
        "",
        escapeTags(record.summary),
      ].join("\n"),
      tone,
    };
  });

  if (runtime.loop.status === "running") {
    items.push({
      key: `active-${runtime.loop.iteration}`,
      label:
        `{bold}${String(runtime.loop.iteration).padStart(2, "0")}{/bold} ` +
        `${roleBadge(activeRole === "none" ? "developer" : activeRole)} ` +
        `{yellow-fg}active{/yellow-fg} ` +
        `${escapeTags(truncate(runtime.loop.task ?? "Working...", 38))}`,
      detail: [
        `{bold}Current baton{/bold}`,
        `${dim("role")} ${escapeTags(activeRole)}`,
        `${dim("task")} ${escapeTags(runtime.loop.task ?? "none")}`,
      ].join("\n"),
      tone: activeRole === "debugger" ? "debugger" : "developer",
    });
  }

  return items.length > 0
    ? items
    : [
        {
          key: "empty",
          label: `${toneTag("muted")}No completed iterations yet{/}`,
          detail: "The loop has not completed any managed turn yet.",
          tone: "muted",
        },
      ];
}

function buildFeed(events: WatchEventRecord[]): WatchFeedItem[] {
  const selected = [...events].slice(-80).reverse();
  if (selected.length === 0) {
    return [
      {
        key: "empty",
        label: `${toneTag("muted")}No watch events yet{/}`,
        detail: "No structured watch events were recorded for this project yet.",
        tone: "muted",
      },
    ];
  }

  return selected.map((event, index) => {
    const tone = toneForEvent(event);
    const stamp = event.at.slice(11, 19);
    const label =
      `{gray-fg}${stamp}{/gray-fg} ` +
      `${event.role ? `${roleBadge(event.role)} ` : ""}` +
      `${toneTag(tone)}${escapeTags(truncate(event.message, 72))}{/}`;
    const detailLines = [
      `{bold}${escapeTags(event.message)}{/bold}`,
      `${dim("at")} ${escapeTags(event.at)}`,
      `${dim("kind")} ${escapeTags(event.kind)}`,
      `${dim("role")} ${escapeTags(event.role ?? "none")}`,
      `${dim("iteration")} ${escapeTags(String(event.iteration ?? "n/a"))}`,
      `${dim("status")} ${escapeTags(event.status ?? "n/a")}`,
      `${dim("thread")} ${escapeTags(event.threadId ?? "n/a")}`,
      `${dim("artifact")} ${escapeTags(event.artifactPath ?? "n/a")}`,
      `${dim("commit")} ${escapeTags(event.commitSha ?? "n/a")}`,
      `${dim("command")} ${escapeTags(event.command ?? "n/a")}`,
      "",
      event.outputPreview
        ? `{bold}Output preview{/bold}\n${escapeTags(event.outputPreview)}`
        : "{gray-fg}No additional detail for this event.{/gray-fg}",
    ];

    return {
      key: `${event.at}-${event.kind}-${event.itemId ?? index}`,
      label,
      detail: detailLines.join("\n"),
      tone,
    };
  });
}

function buildRolePanel(
  runtime: RuntimeState,
  record: IterationRecord | undefined,
  preview: string[],
  role: RoleKind,
): WatchRolePanel {
  const artifactName = record?.artifactPath ? path.basename(record.artifactPath) : "none";
  const commitSha = record?.commitSha ? record.commitSha.slice(0, 12) : runtime.loop.lastCommitSha?.slice(0, 12) ?? "none";
  const latestLabel = record
    ? `iter ${record.iteration} ${record.status}`
    : runtime.loop.status === "running" && runtime.loop.lastRole === role
      ? "in progress"
      : "no completed turn";
  const summary = record?.summary ?? "No completed iteration for this role yet.";
  const threadId = runtime.roles[role]?.threadId ?? "unassigned";

  return {
    role,
    title: capitalizeRole(role),
    tone: role,
    threadId,
    latestLabel,
    artifactName,
    commitSha,
    summary,
    preview: preview.length > 0 ? preview : ["(no artifact preview yet)"],
    detail: [
      `{bold}${capitalizeRole(role)} lane{/bold}`,
      `${dim("thread")} ${escapeTags(threadId)}`,
      `${dim("latest")} ${escapeTags(latestLabel)}`,
      `${dim("artifact")} ${escapeTags(artifactName)}`,
      `${dim("commit")} ${escapeTags(commitSha)}`,
      "",
      `{bold}Summary{/bold}`,
      escapeTags(summary),
      "",
      `{bold}Artifact preview{/bold}`,
      ...(preview.length > 0 ? preview.map((line) => escapeTags(line)) : ["{gray-fg}(no artifact preview yet){/gray-fg}"]),
    ].join("\n"),
  };
}

function renderPlainSnapshot(model: WatchModel): string {
  return [
    `project: ${model.projectId}`,
    `root: ${model.projectRoot}`,
    `loop: ${model.loopStatus}`,
    `iteration: ${model.iteration}`,
    `active_role: ${model.activeRole}`,
    `controller_alive: ${model.controllerAlive}`,
    `task: ${model.task}`,
    "",
    "recent_feed:",
    ...model.feed.slice(0, 8).map((entry) => `- ${stripTags(entry.label)}`),
  ].join("\n");
}

function findLatestRecord(runtime: RuntimeState, role: RoleKind): IterationRecord | undefined {
  return [...runtime.history].reverse().find((record) => record.role === role);
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

function toneForEvent(event: WatchEventRecord): Tone {
  if (event.role === "developer") {
    return "developer";
  }
  if (event.role === "debugger") {
    return "debugger";
  }
  return statusToneOf(event.status ?? event.kind);
}

function statusToneOf(value: string): Tone {
  if (value === "completed" || value === "goal_met" || value === "green") {
    return "ok";
  }
  if (value === "running" || value === "inProgress") {
    return "warn";
  }
  if (value === "blocked" || value === "failed" || value === "orphaned" || value === "interrupted") {
    return "err";
  }
  return "muted";
}

function toneTag(tone: Tone): string {
  switch (tone) {
    case "developer":
      return `{${THEME.developer}-fg}`;
    case "debugger":
      return `{${THEME.debugger}-fg}`;
    case "ok":
      return `{${THEME.ok}-fg}`;
    case "warn":
      return `{${THEME.warn}-fg}`;
    case "err":
      return `{${THEME.err}-fg}`;
    default:
      return `{${THEME.muted}-fg}`;
  }
}

function roleBadge(role: RoleKind): string {
  const tone = role === "developer" ? "developer" : "debugger";
  const label = role === "developer" ? "DEV" : "DBG";
  return `${toneTag(tone)}{bold}${label}{/bold}{/}`;
}

function statusTag(status: string): string {
  return `${toneTag(statusToneOf(status))}${escapeTags(status)}{/}`;
}

function dim(label: string): string {
  return `{${THEME.muted}-fg}${escapeTags(label)}{/}`;
}

function nextPane(pane: PaneMode): PaneMode {
  return pane === "timeline"
    ? "feed"
    : pane === "feed"
      ? "developer"
      : pane === "developer"
        ? "debugger"
        : "timeline";
}

function previousPane(pane: PaneMode): PaneMode {
  return pane === "timeline"
    ? "debugger"
    : pane === "debugger"
      ? "developer"
      : pane === "developer"
        ? "feed"
        : "timeline";
}

function clampIndex(index: number, length: number): number {
  if (length <= 0) {
    return 0;
  }
  return Math.min(Math.max(index, 0), length - 1);
}

function capitalizeRole(role: RoleKind | "none"): string {
  if (role === "none") {
    return "No role";
  }
  return `${role.slice(0, 1).toUpperCase()}${role.slice(1)}`;
}

function truncate(input: string, maxLength: number): string {
  return input.length <= maxLength ? input : `${input.slice(0, maxLength - 1)}…`;
}

function escapeTags(text: string): string {
  return text.replace(/[{}]/g, "");
}

function stripTags(text: string): string {
  return text.replace(/\{\/?[^}]+\}/g, "");
}
