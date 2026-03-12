export const ROLE_KINDS = ["developer", "debugger"] as const;

export type RoleKind = (typeof ROLE_KINDS)[number];
export type LoopStatus =
  | "idle"
  | "running"
  | "completed"
  | "blocked"
  | "stopped"
  | "failed";

export interface CommandContract {
  setup?: string[];
  dry_test: string[];
  use: string[];
}

export interface RoleConfig {
  description: string;
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
  version: 1;
  project: {
    id: string;
    root: string;
  };
  goal: string;
  acceptance: string[];
  commands: CommandContract;
  git: GitConfig;
  loop: LoopConfig;
  roles: Record<string, RoleConfig>;
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

export interface RuntimeState {
  version: 1;
  projectId: string;
  projectRoot: string;
  controllerThreadId?: string;
  roles: Partial<Record<RoleKind, RoleSession>>;
  loop: {
    status: LoopStatus;
    pid?: number;
    iteration: number;
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
  goal: string;
  acceptance?: string[];
  dryTestCommands?: string[];
  useCommands?: string[];
  setupCommands?: string[];
  projectId?: string;
  controllerThreadId?: string;
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
  startRole: RoleKind;
}

export interface ControllerTurnResult {
  status: string;
  summary: string;
  dry_test_passed?: boolean;
  use_passed?: boolean;
  commit_sha?: string;
  handoff_report_path?: string;
  report_path?: string;
  issues?: string[];
  blocking_reason?: string;
}
