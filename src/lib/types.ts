export const ROLE_KINDS = ["developer", "debugger", "scientist", "modeller"] as const;
export const LOOP_KINDS = ["developer-debugger", "scientist-modeller"] as const;
export const REGISTRY_ENTRY_KINDS = ["managed_project", "portfolio"] as const;

export type RoleKind = (typeof ROLE_KINDS)[number];
export type LoopKind = (typeof LOOP_KINDS)[number];
export type RegistryEntryKind = (typeof REGISTRY_ENTRY_KINDS)[number];
export type LoopStatus =
  | "idle"
  | "running"
  | "completed"
  | "blocked"
  | "stopped"
  | "orphaned"
  | "failed";

export const LOOP_ROLE_PAIRS: Record<LoopKind, readonly [RoleKind, RoleKind]> = {
  "developer-debugger": ["developer", "debugger"],
  "scientist-modeller": ["scientist", "modeller"],
};

export const LOOP_VERIFIER_ROLE: Record<LoopKind, RoleKind> = {
  "developer-debugger": "debugger",
  "scientist-modeller": "scientist",
};

export const LOOP_BUILDER_ROLE: Record<LoopKind, RoleKind> = {
  "developer-debugger": "developer",
  "scientist-modeller": "modeller",
};

export const LOOP_START_ROLES: Record<LoopKind, readonly RoleKind[]> = {
  "developer-debugger": ["developer", "debugger"],
  "scientist-modeller": ["scientist"],
};

export interface CommandContract {
  setup?: string[];
  dry_test?: string[];
  restart?: string[];
  use?: string[];
  monitor?: string[];
  monitor_until?: string[];
  monitor_timeout_seconds?: number;
  scientist_research?: string[];
  modeller_design?: string[];
  scientist_assess?: string[];
}

export interface RoleConfig {
  description: string;
  specialization?: string;
  persona?: RolePersona;
}

export interface ProjectCharter {
  title: string;
  domain: string;
  objective: string;
  acceptance: string[];
  evidence_bar: string;
  constraints: string[];
  continuity_summary: string;
}

export interface RolePersona {
  title: string;
  domain: string;
  exemplars: string[];
  methods: string[];
  standards: string[];
  voice_brief: string;
  hidden_instructions: string;
}

export interface LoopConfig {
  max_iterations?: number | null;
  stagnation_limit?: number | null;
}

export interface GitConfig {
  role_branch: string;
  commit_message_template: string;
}

export interface ProjectConfig {
  version: 2 | 3;
  kind?: "managed_project";
  project: {
    id: string;
    root: string;
  };
  loop_kind: LoopKind;
  goal: string;
  domain?: string;
  summary?: string;
  charter?: ProjectCharter;
  acceptance: string[];
  commands: CommandContract;
  git: GitConfig;
  loop: LoopConfig;
  roles: Partial<Record<RoleKind, RoleConfig>>;
}

export interface RoleSession {
  role: RoleKind;
  threadId: string;
  threadName: string;
  sourceMode: "current" | "fork" | "new";
  sourceThreadId?: string;
  assignedAt: string;
}

export interface IterationRecord {
  iteration: number;
  role: RoleKind;
  status: string;
  summary: string;
  artifactPath?: string;
  commitSha?: string;
  at: string;
}

export interface ReasoningSnapshot {
  intent: string;
  current_step: string;
  finding_or_risk: string;
  blocker?: string;
  next_action: string;
}

export type WatchEventKind =
  | "loop_started"
  | "loop_completed"
  | "loop_blocked"
  | "loop_failed"
  | "turn_started"
  | "turn_completed"
  | "turn_status"
  | "commentary"
  | "reasoning_snapshot"
  | "command_started"
  | "command_finished"
  | "artifact_written"
  | "commit_recorded";

export interface WatchEventRecord {
  version: 1;
  at: string;
  kind: WatchEventKind;
  message: string;
  iteration?: number;
  role?: RoleKind;
  status?: string;
  threadId?: string;
  itemId?: string;
  itemType?: string;
  command?: string;
  outputPreview?: string;
  artifactPath?: string;
  commitSha?: string;
  reasoning?: ReasoningSnapshot;
}

export interface LaunchState {
  stagedStartRole?: RoleKind;
  stagedTask?: string;
  stagedAt?: string;
}

export interface RuntimeState {
  version: 2 | 3;
  projectId: string;
  projectRoot: string;
  controllerThreadId?: string;
  roles: Partial<Record<RoleKind, RoleSession>>;
  launch: LaunchState;
  loop: {
    status: LoopStatus;
    pid?: number;
    iteration: number;
    task?: string;
    startedAt?: string;
    endedAt?: string;
    startRole?: RoleKind;
    lastRole?: RoleKind;
    lastCommitSha?: string;
    lastReportPath?: string;
    lastError?: string;
    connectivityIssue?: string;
    connectivityIssueSince?: string;
    connectivityGraceUntil?: string;
  };
  history: IterationRecord[];
}

interface RegistryEntryBase {
  id: string;
  kind: RegistryEntryKind;
  goal: string;
  summary: string;
  domain?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ManagedProjectRegistryEntry extends RegistryEntryBase {
  kind: "managed_project";
  root: string;
  parentId?: string;
}

export interface PortfolioEntry extends RegistryEntryBase {
  kind: "portfolio";
  title: string;
  parentId?: undefined;
  sharedContextSummary?: string;
  rolePersonaHints?: Partial<Record<RoleKind, string>>;
}

export type RegistryEntry = ManagedProjectRegistryEntry | PortfolioEntry;

export interface RegistryFile {
  version: 2;
  projects: RegistryEntry[];
}

export interface CreateProjectInput {
  projectRoot: string;
  loopKind: LoopKind;
  goal: string;
  domain?: string;
  headProjectId?: string;
  acceptance?: string[];
  dryTestCommands?: string[];
  restartCommands?: string[];
  useCommands?: string[];
  monitorCommands?: string[];
  monitorUntil?: string[];
  monitorTimeoutSeconds?: number;
  scientistResearchCommands?: string[];
  modellerDesignCommands?: string[];
  scientistAssessCommands?: string[];
  setupCommands?: string[];
  projectId?: string;
  controllerThreadId?: string;
  developerSpecialization?: string;
  debuggerSpecialization?: string;
  scientistSpecialization?: string;
  modellerSpecialization?: string;
}

export interface CreatePortfolioInput {
  portfolioId?: string;
  title: string;
  goal: string;
  domain?: string;
  summary?: string;
  developerPersonaHint?: string;
  debuggerPersonaHint?: string;
  scientistPersonaHint?: string;
  modellerPersonaHint?: string;
}

export interface SessionSummary {
  threadId: string;
  updatedAt: string;
  preview: string;
  cwd: string;
  name: string | null;
  source: string;
}

export interface AssignmentInput {
  projectRoot: string;
  role: RoleKind;
  mode: "new" | "current" | "old";
  threadId?: string;
  currentThreadId?: string;
}

export interface ManagedProjectOverview {
  kind: "managed_project";
  id: string;
  root: string;
  parentId?: string;
  title: string;
  summary: string;
  domain?: string;
  loopKind: LoopKind;
  loopStatus: LoopStatus;
  activeRole: RoleKind | "none";
  iteration: number;
  task?: string;
  armed: boolean;
  controllerAlive: boolean;
  assignedRoles: RoleKind[];
  lastEventAt?: string;
  latestReasoning?: string;
  latestReasoningRole?: RoleKind;
  updatedAt: string;
}

export interface PortfolioOverview {
  kind: "portfolio";
  id: string;
  title: string;
  goal: string;
  summary: string;
  domain?: string;
  updatedAt: string;
  projects: ManagedProjectOverview[];
}

export interface RegistryOverview {
  portfolios: PortfolioOverview[];
  topLevelProjects: ManagedProjectOverview[];
  runningProjects: ManagedProjectOverview[];
}

export interface LoopStartInput {
  projectRoot: string;
  startRole?: RoleKind;
  task?: string;
}

export interface StageLaunchInput {
  projectRoot: string;
  startRole: RoleKind;
  task: string;
}

export interface MoveProjectInput {
  projectSelector: string;
  newHeadProjectId?: string | null;
}

export interface ControllerTurnResult {
  status: string;
  summary: string;
  dry_test_passed?: boolean;
  use_passed?: boolean;
  restart_performed?: boolean;
  monitor_result?: "not_configured" | "caveat_observed" | "process_ended" | "timeout_reached";
  observed_caveat?: string;
  design_ready?: boolean;
  assessment_passed?: boolean;
  commit_sha?: string;
  handoff_report_path?: string;
  report_path?: string;
  model_report_path?: string;
  assessment_report_path?: string;
  issues?: string[];
  blocking_reason?: string;
}

export function activeRolesForLoopKind(loopKind: LoopKind): readonly [RoleKind, RoleKind] {
  return LOOP_ROLE_PAIRS[loopKind];
}

export function builderRoleForLoopKind(loopKind: LoopKind): RoleKind {
  return LOOP_BUILDER_ROLE[loopKind];
}

export function verifierRoleForLoopKind(loopKind: LoopKind): RoleKind {
  return LOOP_VERIFIER_ROLE[loopKind];
}

export function allowedStartRolesForLoopKind(loopKind: LoopKind): readonly RoleKind[] {
  return LOOP_START_ROLES[loopKind];
}

export function isRoleAllowedForLoopKind(loopKind: LoopKind, role: RoleKind): boolean {
  return activeRolesForLoopKind(loopKind).includes(role);
}

export function roleTitle(role: RoleKind): string {
  return `${role.slice(0, 1).toUpperCase()}${role.slice(1)}`;
}
