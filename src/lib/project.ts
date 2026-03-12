import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";

import { appendUniqueLines, ensureDir, pathExists, readJsonFile, writeJsonFile } from "./fs.js";
import {
  artifactsDir,
  controllerLogPath,
  legacyArtifactsDir,
  legacyControllerLogPath,
  legacyProjectConfigPath,
  legacyProjectStateDir,
  legacyRuntimeStatePath,
  projectConfigPath,
  projectStateDir,
  runtimeStatePath,
  specPath,
} from "./paths.js";
import type {
  CreateProjectInput,
  ProjectConfig,
  RoleKind,
  RuntimeState,
} from "./types.js";

export function makeProjectId(projectRoot: string, explicitId?: string): string {
  if (explicitId) {
    return sanitizeId(explicitId);
  }

  const base = path.basename(projectRoot) || "project";
  return sanitizeId(base);
}

export function sanitizeId(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "project";
}

export function defaultBranchName(projectId: string): string {
  return `devise/${projectId}/developer`;
}

export function defaultProjectConfig(input: CreateProjectInput): ProjectConfig {
  const projectId = makeProjectId(input.projectRoot, input.projectId);
  return {
    version: 1,
    project: {
      id: projectId,
      root: path.resolve(input.projectRoot),
    },
    goal: input.goal,
    acceptance: input.acceptance ?? [
      "Replace this placeholder with explicit success criteria.",
    ],
    commands: {
      setup: input.setupCommands ?? [],
      dry_test:
        input.dryTestCommands ?? [
          'printf "Set commands.dry_test in .devise/project.yaml\\n" && exit 1',
        ],
      restart: input.restartCommands ?? [],
      use:
        input.useCommands ?? [
          'printf "Set commands.use in .devise/project.yaml\\n" && exit 1',
        ],
      monitor: input.monitorCommands ?? [],
      monitor_until: input.monitorUntil ?? [],
      monitor_timeout_seconds: input.monitorTimeoutSeconds ?? 300,
    },
    git: {
      role_branch: defaultBranchName(projectId),
      commit_message_template: `role(${projectId}): developer iteration {{iteration}}`,
    },
    loop: {
      max_iterations: 10,
      stagnation_limit: 2,
    },
    roles: {
      developer: {
        description: "Patches code until dry-test passes and commits the result.",
      },
      debugger: {
        description:
          "Runs the real use flow, writes a detailed report, and decides whether the goal is met.",
      },
    },
  };
}

export function defaultRuntimeState(
  projectConfig: ProjectConfig,
  controllerThreadId?: string,
): RuntimeState {
  return {
    version: 1,
    projectId: projectConfig.project.id,
    projectRoot: projectConfig.project.root,
    controllerThreadId,
    roles: {},
    launch: {},
    loop: {
      status: "idle",
      iteration: 0,
    },
    history: [],
  };
}

export async function createProjectFiles(
  input: CreateProjectInput,
): Promise<{ project: ProjectConfig; runtime: RuntimeState }> {
  const root = path.resolve(input.projectRoot);
  const project = defaultProjectConfig({ ...input, projectRoot: root });
  const runtime = defaultRuntimeState(project, input.controllerThreadId);

  await ensureDir(root);
  await ensureDir(projectStateDir(root));
  await ensureDir(artifactsDir(root));

  const spec = renderProjectSpec(project);
  await fs.writeFile(specPath(root), spec, "utf8");
  await fs.writeFile(projectConfigPath(root), YAML.stringify(project), "utf8");
  await writeJsonFile(runtimeStatePath(root), runtime);
  await appendUniqueLines(path.join(root, ".gitignore"), [
    ".devise/runtime.json",
    ".devise/artifacts/",
    ".devise/controller.log",
  ]);

  return { project, runtime };
}

export async function loadProjectConfig(projectRoot: string): Promise<ProjectConfig> {
  const configPath = await resolveProjectConfigPath(projectRoot);
  if (!(await pathExists(configPath))) {
    throw new Error(`Project config not found at ${configPath}`);
  }

  const raw = await fs.readFile(configPath, "utf8");
  const parsed = YAML.parse(raw) as ProjectConfig;
  validateProjectConfig(parsed, configPath);
  return parsed;
}

export async function saveProjectConfig(project: ProjectConfig): Promise<void> {
  const configPath = await resolveProjectConfigPath(project.project.root);
  await fs.writeFile(
    configPath,
    YAML.stringify(project),
    "utf8",
  );
}

export async function loadRuntimeState(projectRoot: string): Promise<RuntimeState> {
  const project = await loadProjectConfig(projectRoot);
  const runtime = await readJsonFile(
    await resolveRuntimeStatePath(project.project.root),
    defaultRuntimeState(project),
  );
  return normalizeRuntimeState(project, runtime);
}

export async function saveRuntimeState(runtime: RuntimeState): Promise<void> {
  await writeJsonFile(await resolveRuntimeStatePath(runtime.projectRoot), runtime);
}

export function ensureRoleAssigned(
  runtime: RuntimeState,
  role: RoleKind,
): asserts runtime is RuntimeState & {
  roles: Record<RoleKind, NonNullable<RuntimeState["roles"][RoleKind]>>;
} {
  if (!runtime.roles[role]) {
    throw new Error(`Role ${role} has not been assigned for project ${runtime.projectId}`);
  }
}

export function renderProjectSpec(project: ProjectConfig): string {
  const restart = (project.commands.restart ?? []).map((item) => `- \`${item}\``).join("\n");
  const acceptance = project.acceptance.map((item) => `- ${item}`).join("\n");
  const dryTest = project.commands.dry_test.map((item) => `- \`${item}\``).join("\n");
  const useFlow = project.commands.use.map((item) => `- \`${item}\``).join("\n");
  const monitor = (project.commands.monitor ?? []).map((item) => `- \`${item}\``).join("\n");
  const monitorUntil = (project.commands.monitor_until ?? []).map((item) => `- ${item}`).join("\n");
  const monitorTimeout = project.commands.monitor_timeout_seconds ?? 300;

  return `# Project Spec\n\n## Goal\n\n${project.goal}\n\n## Acceptance Criteria\n\n${acceptance}\n\n## Dry Test Commands\n\n${dryTest}\n\n## Debugger Clean Restart Commands\n\n${restart || "- None configured."}\n\n## Real Use Commands\n\n${useFlow}\n\n## Debugger Monitor Commands\n\n${monitor || "- None configured."}\n\n## Debugger Caveats To Watch For\n\n${monitorUntil || "- None configured."}\n\n## Debugger Monitor Timeout Seconds\n\n${monitorTimeout}\n`;
}

export async function hasManagedProjectConfig(projectRoot: string): Promise<boolean> {
  return pathExists(await resolveProjectConfigPath(projectRoot));
}

export async function resolveProjectStateDir(projectRoot: string): Promise<string> {
  const resolvedRoot = path.resolve(projectRoot);
  const currentDir = projectStateDir(resolvedRoot);
  if (await pathExists(currentDir)) {
    return currentDir;
  }

  const legacyDir = legacyProjectStateDir(resolvedRoot);
  if (await pathExists(legacyDir)) {
    return legacyDir;
  }

  return currentDir;
}

export async function resolveProjectConfigPath(projectRoot: string): Promise<string> {
  const resolvedRoot = path.resolve(projectRoot);
  const currentPath = projectConfigPath(resolvedRoot);
  if (await pathExists(currentPath)) {
    return currentPath;
  }

  const legacyPath = legacyProjectConfigPath(resolvedRoot);
  if (await pathExists(legacyPath)) {
    return legacyPath;
  }

  return currentPath;
}

export async function resolveRuntimeStatePath(projectRoot: string): Promise<string> {
  const resolvedRoot = path.resolve(projectRoot);
  const currentPath = runtimeStatePath(resolvedRoot);
  if (await pathExists(currentPath)) {
    return currentPath;
  }

  const legacyPath = legacyRuntimeStatePath(resolvedRoot);
  if (await pathExists(legacyPath)) {
    return legacyPath;
  }

  return currentPath;
}

export async function resolveArtifactsDir(projectRoot: string): Promise<string> {
  const resolvedRoot = path.resolve(projectRoot);
  const currentPath = artifactsDir(resolvedRoot);
  if (await pathExists(currentPath)) {
    return currentPath;
  }

  const legacyPath = legacyArtifactsDir(resolvedRoot);
  if (await pathExists(legacyPath)) {
    return legacyPath;
  }

  return currentPath;
}

export async function resolveControllerLogPath(projectRoot: string): Promise<string> {
  const resolvedRoot = path.resolve(projectRoot);
  const currentPath = controllerLogPath(resolvedRoot);
  if (await pathExists(currentPath)) {
    return currentPath;
  }

  const legacyPath = legacyControllerLogPath(resolvedRoot);
  if (await pathExists(legacyPath)) {
    return legacyPath;
  }

  return currentPath;
}

function normalizeRuntimeState(
  project: ProjectConfig,
  runtime: RuntimeState,
): RuntimeState {
  const fallback = defaultRuntimeState(project, runtime.controllerThreadId);
  return {
    ...fallback,
    ...runtime,
    roles: runtime.roles ?? {},
    launch: {
      ...fallback.launch,
      ...(runtime.launch ?? {}),
    },
    loop: {
      ...fallback.loop,
      ...(runtime.loop ?? {}),
    },
    history: runtime.history ?? [],
  };
}

function validateProjectConfig(project: ProjectConfig, configPath: string): void {
  if (!project?.project?.id || !project?.project?.root) {
    throw new Error(`Invalid project config at ${configPath}: missing project.id or project.root`);
  }

  if (!Array.isArray(project.acceptance) || project.acceptance.length === 0) {
    throw new Error(`Invalid project config at ${configPath}: acceptance must be a non-empty list`);
  }

  if (!Array.isArray(project.commands?.dry_test) || project.commands.dry_test.length === 0) {
    throw new Error(`Invalid project config at ${configPath}: commands.dry_test must be a non-empty list`);
  }

  if (!Array.isArray(project.commands?.use) || project.commands.use.length === 0) {
    throw new Error(`Invalid project config at ${configPath}: commands.use must be a non-empty list`);
  }
}
