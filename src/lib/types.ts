export const ROLE_KINDS = ["developer", "debugger", "scientist", "modeller"] as const;
export const LOOP_KINDS = ["developer-debugger", "scientist-modeller"] as const;

export type RoleKind = (typeof ROLE_KINDS)[number];
export type LoopKind = (typeof LOOP_KINDS)[number];
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
}

export interface LoopConfig {
  max_iterations: number;
  stagnation_limit: number;
}

export interface GitConfig {
  role_branch: string;
  commit_message_template: string;
}

export interface ProjectConfig {
  version: 2;
  project: {
    id: string;
    root: string;
  };
  loop_kind: LoopKind;
  goal: string;
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

export type WatchEventKind =
  | "loop_started"
  | "loop_completed"
  | "loop_blocked"
  | "loop_failed"
  | "turn_started"
  | "turn_completed"
  | "turn_status"
  | "commentary"
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
}

export interface LaunchState {
  stagedStartRole?: RoleKind;
  stagedTask?: string;
  stagedAt?: string;
}

export interface RuntimeState {
  version: 2;
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
  };
  history: IterationRecord[];
}

export interface RegistryEntry {
  id: string;
  root: string;
  goal: string;
  createdAt: string;
  updatedAt: string;
}

export interface RegistryFile {
  version: 1;
  projects: RegistryEntry[];
}

export interface CreateProjectInput {
  projectRoot: string;
  loopKind: LoopKind;
  goal: string;
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
  mode: "current" | "old";
  threadId?: string;
  currentThreadId?: string;
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
