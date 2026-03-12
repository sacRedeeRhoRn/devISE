import blessed from "blessed";

import { resolveControllerLogPath, resolveWatchEventsPath } from "./project.js";
import type { RoleService } from "./service.js";
import type {
  ManagedProjectOverview,
  PortfolioOverview,
  RegistryOverview,
} from "./types.js";
import { buildSnapshot, buildWatchModel } from "./watch.js";

type DashboardFocus = "tree" | "feed";

type DashboardTreeItem =
  | {
      key: string;
      kind: "portfolio";
      label: string;
      portfolio: PortfolioOverview;
    }
  | {
      key: string;
      kind: "project";
      label: string;
      project: ManagedProjectOverview;
    };

type DashboardSelection =
  | {
      kind: "portfolio";
      portfolio: PortfolioOverview;
    }
  | {
      kind: "project";
      overview: ManagedProjectOverview;
      watchModel: ReturnType<typeof buildWatchModel>;
    }
  | {
      kind: "empty";
    };

interface DashboardFeedItem {
  key: string;
  label: string;
  detail: string;
}

interface DashboardModel {
  overview: RegistryOverview;
  tree: DashboardTreeItem[];
  selection: DashboardSelection;
  feed: DashboardFeedItem[];
  title: string;
  note: string;
}

interface DashboardUi {
  screen: blessed.Widgets.Screen;
  header: blessed.Widgets.BoxElement;
  tree: blessed.Widgets.ListElement;
  running: blessed.Widgets.BoxElement;
  summary: blessed.Widgets.BoxElement;
  feed: blessed.Widgets.ListElement;
  detail: blessed.Widgets.BoxElement;
  help: blessed.Widgets.BoxElement;
}

interface DashboardState {
  focus: DashboardFocus;
  treeIndex: number;
  feedIndex: number;
  helpOpen: boolean;
}

const THEME = {
  bg: "#101513",
  panel: "#18211d",
  panelAlt: "#1f2b26",
  border: "#486156",
  text: "#eff4ee",
  muted: "#9db2a7",
  accent: "#cde3d6",
  running: "#83c692",
  staged: "#d9b56f",
  blocked: "#d97d70",
  portfolio: "#8ab6d4",
  tree: "#b8cfc1",
  shadow: "#0a0d0b",
};

const SPINNER = ["●", "◐", "●", "◑"];

export async function startDashboard(
  service: RoleService,
  options: { selector?: string; projectFocus?: boolean } = {},
): Promise<void> {
  const { selector, projectFocus = false } = options;
  if (!process.stdout.isTTY) {
    const model = await loadDashboardModel(service, selector, 0, projectFocus);
    process.stdout.write(renderPlainDashboard(model));
    return;
  }

  const ui = createDashboardUi(projectFocus);
  const state: DashboardState = {
    focus: "tree",
    treeIndex: 0,
    feedIndex: 0,
    helpOpen: false,
  };
  let spinnerIndex = 0;
  let currentSelectionKey = selector;
  let closed = false;
  let model = await loadDashboardModel(service, currentSelectionKey, spinnerIndex, projectFocus);
  state.treeIndex = resolveTreeIndex(model.tree, currentSelectionKey);

  const redraw = (): void => {
    renderDashboardUi(ui, model, state, projectFocus);
  };

  const refresh = async (): Promise<void> => {
    const selectionKey = currentSelectionKey ?? model.tree[state.treeIndex]?.key;
    const nextModel = await loadDashboardModel(
      service,
      selectionKey,
      spinnerIndex,
      projectFocus,
    );
    spinnerIndex = (spinnerIndex + 1) % SPINNER.length;
    model = nextModel;
    currentSelectionKey = nextModel.tree[resolveTreeIndex(nextModel.tree, selectionKey)]?.key;
    state.treeIndex = resolveTreeIndex(nextModel.tree, currentSelectionKey);
    state.feedIndex = clampIndex(state.feedIndex, nextModel.feed.length);
    redraw();
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
    state.focus = state.focus === "tree" ? "feed" : "tree";
    redraw();
  });
  ui.screen.key(["?"], () => {
    state.helpOpen = !state.helpOpen;
    ui.help.hidden = !state.helpOpen;
    ui.screen.render();
  });
  ui.screen.key(["r"], () => {
    void refresh();
  });
  ui.screen.key(["up", "k"], () => {
    if (state.focus === "tree") {
      state.treeIndex = clampIndex(state.treeIndex - 1, model.tree.length);
      currentSelectionKey = model.tree[state.treeIndex]?.key;
      state.feedIndex = 0;
      void refresh();
      return;
    }
    state.feedIndex = clampIndex(state.feedIndex - 1, model.feed.length);
    redraw();
  });
  ui.screen.key(["down", "j"], () => {
    if (state.focus === "tree") {
      state.treeIndex = clampIndex(state.treeIndex + 1, model.tree.length);
      currentSelectionKey = model.tree[state.treeIndex]?.key;
      state.feedIndex = 0;
      void refresh();
      return;
    }
    state.feedIndex = clampIndex(state.feedIndex + 1, model.feed.length);
    redraw();
  });

  const interval = setInterval(() => {
    void refresh().catch((error) => {
      ui.detail.setContent(`{red-fg}${escapeTags(String(error))}{/red-fg}`);
      ui.screen.render();
    });
  }, 1500);
  ui.screen.once("destroy", () => clearInterval(interval));

  redraw();
  await new Promise<void>((resolve) => {
    ui.screen.once("destroy", resolve);
  });
}

async function loadDashboardModel(
  service: RoleService,
  selector: string | undefined,
  spinnerIndex: number,
  projectFocus = false,
): Promise<DashboardModel> {
  const overview = await service.listRegistryOverview();
  const tree = buildTree(overview);
  const selectionKey = resolveSelectionKey(tree, selector);
  const selection = await loadSelection(service, tree, selectionKey, spinnerIndex);
  const feed = buildFeedForSelection(selection);
  return {
    overview,
    tree,
    selection,
    feed,
    title: projectFocus ? "devISE watch" : "devISE dashboard",
    note:
      selection.kind === "project"
        ? selection.watchModel.headerNote
        : "Observable output only. Hidden chain-of-thought is not available.",
  };
}

async function loadSelection(
  service: RoleService,
  tree: DashboardTreeItem[],
  selectionKey: string | undefined,
  spinnerIndex: number,
): Promise<DashboardSelection> {
  const row = tree.find((item) => item.key === selectionKey) ?? tree[0];
  if (!row) {
    return { kind: "empty" };
  }

  if (row.kind === "portfolio") {
    return {
      kind: "portfolio",
      portfolio: row.portfolio,
    };
  }

  const status = await service.getStatus(row.project.root);
  const projectRoot = status.project.project.root;
  const snapshot = await buildSnapshot(
    status.project,
    status.runtime,
    status.controllerAlive,
    await resolveWatchEventsPath(projectRoot),
    await resolveControllerLogPath(projectRoot),
  );
  return {
    kind: "project",
    overview: row.project,
    watchModel: buildWatchModel(snapshot, spinnerIndex),
  };
}

function buildTree(overview: RegistryOverview): DashboardTreeItem[] {
  const rows: DashboardTreeItem[] = [];
  for (const portfolio of overview.portfolios) {
    rows.push({
      key: `portfolio:${portfolio.id}`,
      kind: "portfolio",
      label: `${toneTag("portfolio")}◈ ${escapeTags(portfolio.title)}{/} {${THEME.muted}-fg}[${portfolio.projects.length}]{/}`,
      portfolio,
    });
    for (const project of portfolio.projects) {
      rows.push({
        key: `project:${project.id}`,
        kind: "project",
        label: `  ${projectBadge(project)} ${escapeTags(project.title)}`,
        project,
      });
    }
  }
  for (const project of overview.topLevelProjects) {
    rows.push({
      key: `project:${project.id}`,
      kind: "project",
      label: `${projectBadge(project)} ${escapeTags(project.title)}`,
      project,
    });
  }
  return rows;
}

function createDashboardUi(projectFocus = false): DashboardUi {
  const screen = blessed.screen({
    smartCSR: true,
    title: projectFocus ? "devISE watch" : "devISE dashboard",
    dockBorders: true,
    fullUnicode: true,
  });

  const header = blessed.box({
    parent: screen,
    top: 0,
    left: 0,
    right: 0,
    height: 4,
    tags: true,
    style: { bg: THEME.bg, fg: THEME.text },
  });

  const tree = blessed.list({
    parent: screen,
    top: 4,
    left: 0,
    width: "30%",
    bottom: 9,
    border: "line",
    label: " Portfolios ",
    tags: true,
    style: {
      bg: THEME.panel,
      fg: THEME.tree,
      border: { fg: THEME.border },
      selected: { bg: THEME.panelAlt, fg: THEME.accent, bold: true },
      item: { fg: THEME.tree },
    },
    scrollbar: {
      ch: " ",
      track: { bg: THEME.shadow },
      style: { bg: THEME.border },
    },
  });

  const running = blessed.box({
    parent: screen,
    top: 4,
    left: "30%",
    right: 0,
    height: 8,
    border: "line",
    label: " Running Now ",
    tags: true,
    style: {
      bg: THEME.panel,
      fg: THEME.text,
      border: { fg: THEME.running },
    },
  });

  const summary = blessed.box({
    parent: screen,
    top: 12,
    left: "30%",
    right: 0,
    height: 14,
    border: "line",
    label: projectFocus ? " Selected Project " : " Selection ",
    tags: true,
    scrollable: true,
    alwaysScroll: true,
    style: {
      bg: THEME.panel,
      fg: THEME.text,
      border: { fg: THEME.border },
    },
    scrollbar: {
      ch: " ",
      track: { bg: THEME.shadow },
      style: { bg: THEME.muted },
    },
  });

  const feed = blessed.list({
    parent: screen,
    top: 26,
    left: "30%",
    right: 0,
    bottom: 9,
    border: "line",
    label: " Reasoning & Activity ",
    tags: true,
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
    height: 9,
    top: "center",
    left: "center",
    border: "line",
    label: " Shortcuts ",
    tags: true,
    hidden: true,
    style: {
      bg: THEME.panelAlt,
      fg: THEME.text,
      border: { fg: THEME.staged },
    },
    content: [
      "{bold}q{/bold} quit",
      "{bold}Tab{/bold} cycle focus between tree and feed",
      "{bold}↑ ↓{/bold} or {bold}j k{/bold} move selection",
      "{bold}r{/bold} refresh immediately",
      "{bold}?{/bold} toggle this help",
    ].join("\n"),
  });

  return { screen, header, tree, running, summary, feed, detail, help };
}

function renderDashboardUi(
  ui: DashboardUi,
  model: DashboardModel,
  state: DashboardState,
  projectFocus = false,
): void {
  state.treeIndex = clampIndex(state.treeIndex, model.tree.length);
  state.feedIndex = clampIndex(state.feedIndex, model.feed.length);

  ui.header.setContent(renderHeader(model, projectFocus));
  ui.tree.setItems(model.tree.map((item) => item.label));
  ui.tree.select(state.treeIndex);
  ui.running.setContent(renderRunning(model.overview));
  ui.summary.setContent(renderSelectionSummary(model.selection));
  ui.feed.setItems(model.feed.map((item) => item.label));
  ui.feed.select(state.feedIndex);
  ui.detail.setContent(renderDetail(model.selection, model.feed[state.feedIndex], state.focus));

  ui.tree.style.border.fg = state.focus === "tree" ? THEME.accent : THEME.border;
  ui.feed.style.border.fg = state.focus === "feed" ? THEME.accent : THEME.border;
  ui.summary.style.border.fg = projectFocus ? THEME.running : THEME.border;

  ui.screen.render();
}

function renderHeader(model: DashboardModel, projectFocus: boolean): string {
  const totalProjects =
    model.overview.topLevelProjects.length +
    model.overview.portfolios.reduce((count, portfolio) => count + portfolio.projects.length, 0);
  const blocked = allProjects(model.overview).filter((project) =>
    ["blocked", "failed", "orphaned"].includes(project.loopStatus),
  ).length;
  const staged = allProjects(model.overview).filter((project) => project.armed).length;

  return [
    `{bold}${projectFocus ? "devISE watch" : "devISE dashboard"}{/bold} ` +
      `${dim("projects")} ${totalProjects}   ${dim("running")} ${model.overview.runningProjects.length}   ` +
      `${dim("blocked")} ${blocked}   ${dim("staged")} ${staged}   ${dim("portfolios")} ${model.overview.portfolios.length}`,
    `${dim("selection")} ${escapeTags(selectionLabel(model.selection))}`,
    `${dim("note")} ${escapeTags(model.note)}`,
  ].join("\n");
}

function renderRunning(overview: RegistryOverview): string {
  if (overview.runningProjects.length === 0) {
    return "{gray-fg}No running projects right now.{/gray-fg}";
  }

  return overview.runningProjects
    .slice(0, 8)
    .map(
      (project) =>
        `${projectBadge(project)} ${escapeTags(project.title)} ` +
        `{${THEME.muted}-fg}iter ${project.iteration}, active ${project.activeRole}{/} ` +
        `${escapeTags(project.latestReasoning ?? project.task ?? "No recent observable reasoning.")}`,
    )
    .join("\n");
}

function renderSelectionSummary(selection: DashboardSelection): string {
  if (selection.kind === "empty") {
    return "{gray-fg}No devISE projects were found in the registry yet.{/gray-fg}";
  }

  if (selection.kind === "portfolio") {
    const running = selection.portfolio.projects.filter((project) => project.loopStatus === "running").length;
    return [
      `{bold}${escapeTags(selection.portfolio.title)}{/bold}`,
      `${dim("portfolio_id")} ${escapeTags(selection.portfolio.id)}`,
      `${dim("domain")} ${escapeTags(selection.portfolio.domain ?? "none")}`,
      `${dim("projects")} ${selection.portfolio.projects.length}   ${dim("running")} ${running}`,
      "",
      escapeTags(selection.portfolio.summary),
      "",
      "{bold}Children{/bold}",
      ...(selection.portfolio.projects.length > 0
        ? selection.portfolio.projects.map(
            (project) =>
              `${stripProjectBadge(project)} ${project.title} (${project.loopStatus}, iter ${project.iteration})`,
          )
        : ["{gray-fg}No child projects yet.{/gray-fg}"]),
    ].join("\n");
  }

  const model = selection.watchModel;
  return [
    `{bold}${escapeTags(model.projectTitle)}{/bold}`,
    `${dim("project_id")} ${escapeTags(model.projectId)}`,
    `${dim("domain")} ${escapeTags(model.projectDomain)}`,
    `${dim("loop")} ${escapeTags(model.loopStatus)}   ${dim("iter")} ${model.iteration}   ${dim("active")} ${escapeTags(model.activeRole)}`,
    `${dim("controller")} ${escapeTags(model.controllerAlive ? "alive" : "stopped")}   ${dim("task")} ${escapeTags(model.task)}`,
    "",
    escapeTags(model.projectSummary),
    "",
    `{bold}${escapeTags(model.roleA.title)}{/bold} ${dim("latest")} ${escapeTags(model.roleA.latestLabel)}`,
    `${dim("reasoning")} ${escapeTags(model.roleA.latestReasoning ?? "No recent reasoning snapshot.")}`,
    `{bold}${escapeTags(model.roleB.title)}{/bold} ${dim("latest")} ${escapeTags(model.roleB.latestLabel)}`,
    `${dim("reasoning")} ${escapeTags(model.roleB.latestReasoning ?? "No recent reasoning snapshot.")}`,
  ].join("\n");
}

function renderDetail(
  selection: DashboardSelection,
  feedItem: DashboardFeedItem | undefined,
  focus: DashboardFocus,
): string {
  if (focus === "feed" && feedItem) {
    return feedItem.detail;
  }

  if (selection.kind === "project") {
    return [
      selection.watchModel.roleA.detail,
      "",
      selection.watchModel.roleB.detail,
    ].join("\n");
  }

  if (selection.kind === "portfolio") {
    return [
      `{bold}${escapeTags(selection.portfolio.title)}{/bold}`,
      `${dim("goal")} ${escapeTags(selection.portfolio.goal)}`,
      `${dim("summary")} ${escapeTags(selection.portfolio.summary)}`,
      "",
      "{bold}Child projects{/bold}",
      ...(selection.portfolio.projects.length > 0
        ? selection.portfolio.projects.map(
            (project) =>
              `${project.title}\n${dim("status")} ${project.loopStatus}   ${dim("task")} ${escapeTags(project.task ?? "none")}`,
          )
        : ["{gray-fg}No child projects yet.{/gray-fg}"]),
    ].join("\n");
  }

  return "{gray-fg}Select a project to inspect live reasoning and artifacts.{/gray-fg}";
}

function buildFeedForSelection(selection: DashboardSelection): DashboardFeedItem[] {
  if (selection.kind === "project") {
    return selection.watchModel.feed.map((item) => ({
      key: item.key,
      label: item.label,
      detail: item.detail,
    }));
  }

  if (selection.kind === "portfolio") {
    if (selection.portfolio.projects.length === 0) {
      return [
        {
          key: "empty",
          label: "{gray-fg}No child projects yet{/gray-fg}",
          detail: "This portfolio does not contain any managed child projects yet.",
        },
      ];
    }
    return selection.portfolio.projects.map((project) => ({
      key: project.id,
      label: `${projectBadge(project)} ${escapeTags(project.title)}`,
      detail: [
        `{bold}${escapeTags(project.title)}{/bold}`,
        `${dim("loop")} ${escapeTags(project.loopStatus)}   ${dim("iter")} ${project.iteration}   ${dim("active")} ${escapeTags(project.activeRole)}`,
        `${dim("task")} ${escapeTags(project.task ?? "none")}`,
        `${dim("reasoning")} ${escapeTags(project.latestReasoning ?? "No recent observable reasoning.")}`,
      ].join("\n"),
    }));
  }

  return [
    {
      key: "empty",
      label: "{gray-fg}No projects yet{/gray-fg}",
      detail: "Create or resume a devISE project to populate the dashboard.",
    },
  ];
}

function renderPlainDashboard(model: DashboardModel): string {
  return [
    `view: ${model.title}`,
    `running_projects: ${model.overview.runningProjects.length}`,
    `portfolios: ${model.overview.portfolios.length}`,
    "",
    "running_now:",
    ...model.overview.runningProjects
      .slice(0, 8)
      .map(
        (project) =>
          `- ${project.title} [${project.loopStatus}] active=${project.activeRole} iter=${project.iteration} note=${project.latestReasoning ?? project.task ?? "none"}`,
      ),
    "",
    "tree:",
    ...model.tree.map((item) => `- ${stripTags(item.label)}`),
  ].join("\n");
}

function resolveSelectionKey(
  tree: DashboardTreeItem[],
  selector: string | undefined,
): string | undefined {
  if (selector) {
    const matched = tree.find((item) =>
      item.kind === "project"
        ? item.project.id === selector || item.project.root === selector || item.key === selector
        : item.portfolio.id === selector || item.key === selector,
    );
    if (matched) {
      return matched.key;
    }
  }

  return (
    tree.find((item) => item.kind === "project" && item.project.loopStatus === "running")?.key ??
    tree.find((item) => item.kind === "project")?.key ??
    tree[0]?.key
  );
}

function resolveTreeIndex(tree: DashboardTreeItem[], selectionKey: string | undefined): number {
  const index = tree.findIndex((item) => item.key === selectionKey);
  return index >= 0 ? index : 0;
}

function clampIndex(index: number, length: number): number {
  if (length <= 0) {
    return 0;
  }
  return Math.min(Math.max(index, 0), length - 1);
}

function allProjects(overview: RegistryOverview): ManagedProjectOverview[] {
  return [
    ...overview.topLevelProjects,
    ...overview.portfolios.flatMap((portfolio) => portfolio.projects),
  ];
}

function projectBadge(project: ManagedProjectOverview): string {
  const tone =
    project.loopStatus === "running"
      ? "running"
      : project.loopStatus === "blocked" || project.loopStatus === "failed" || project.loopStatus === "orphaned"
        ? "blocked"
        : project.armed
          ? "staged"
          : "tree";
  const marker =
    project.loopStatus === "running"
      ? "RUN"
      : project.loopStatus === "completed"
        ? "DONE"
        : project.armed
          ? "ARM"
          : project.loopStatus === "blocked" || project.loopStatus === "failed" || project.loopStatus === "orphaned"
            ? "ALR"
            : "IDL";
  return `${toneTag(tone)}{bold}${marker}{/bold}{/}`;
}

function stripProjectBadge(project: ManagedProjectOverview): string {
  return `[${project.loopStatus}]`;
}

function selectionLabel(selection: DashboardSelection): string {
  if (selection.kind === "project") {
    return `${selection.watchModel.projectTitle} (${selection.watchModel.projectId})`;
  }
  if (selection.kind === "portfolio") {
    return `${selection.portfolio.title} (${selection.portfolio.id})`;
  }
  return "No selection";
}

function toneTag(tone: "portfolio" | "running" | "blocked" | "staged" | "tree"): string {
  switch (tone) {
    case "portfolio":
      return `{${THEME.portfolio}-fg}`;
    case "running":
      return `{${THEME.running}-fg}`;
    case "blocked":
      return `{${THEME.blocked}-fg}`;
    case "staged":
      return `{${THEME.staged}-fg}`;
    default:
      return `{${THEME.tree}-fg}`;
  }
}

function dim(label: string): string {
  return `{${THEME.muted}-fg}${escapeTags(label)}{/}`;
}

function escapeTags(text: string): string {
  return text.replace(/[{}]/g, "");
}

function stripTags(text: string): string {
  return text.replace(/\{\/?[^}]+\}/g, "");
}
