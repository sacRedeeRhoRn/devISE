import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";

import { appendUniqueLines, ensureDir, pathExists, readJsonFile, writeJsonFile } from "./fs.js";
import {
  artifactsDir,
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
      use:
        input.useCommands ?? [
          'printf "Set commands.use in .devise/project.yaml\\n" && exit 1',
        ],
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
  const configPath = projectConfigPath(path.resolve(projectRoot));
  if (!(await pathExists(configPath))) {
    throw new Error(`Project config not found at ${configPath}`);
  }

  const raw = await fs.readFile(configPath, "utf8");
  const parsed = YAML.parse(raw) as ProjectConfig;
  validateProjectConfig(parsed, configPath);
  return parsed;
}

export async function saveProjectConfig(project: ProjectConfig): Promise<void> {
  await fs.writeFile(
    projectConfigPath(project.project.root),
    YAML.stringify(project),
    "utf8",
  );
}

export async function loadRuntimeState(projectRoot: string): Promise<RuntimeState> {
  const project = await loadProjectConfig(projectRoot);
  return readJsonFile(runtimeStatePath(project.project.root), defaultRuntimeState(project));
}

export async function saveRuntimeState(runtime: RuntimeState): Promise<void> {
  await writeJsonFile(runtimeStatePath(runtime.projectRoot), runtime);
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
  const acceptance = project.acceptance.map((item) => `- ${item}`).join("\n");
  const dryTest = project.commands.dry_test.map((item) => `- \`${item}\``).join("\n");
  const useFlow = project.commands.use.map((item) => `- \`${item}\``).join("\n");

  return `# Project Spec\n\n## Goal\n\n${project.goal}\n\n## Acceptance Criteria\n\n${acceptance}\n\n## Dry Test Commands\n\n${dryTest}\n\n## Real Use Commands\n\n${useFlow}\n`;
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
