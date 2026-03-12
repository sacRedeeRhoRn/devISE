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
  legacyWatchEventsPath,
  projectConfigPath,
  projectStateDir,
  runtimeStatePath,
  specPath,
  watchEventsPath,
} from "./paths.js";
import {
  activeRolesForLoopKind,
  builderRoleForLoopKind,
  isRoleAllowedForLoopKind,
  type CreateProjectInput,
  type LoopKind,
  type PortfolioEntry,
  type ProjectConfig,
  type RoleConfig,
  type RoleKind,
  type RuntimeState,
  roleTitle,
} from "./types.js";
import {
  generateProjectCharter,
  generateRoleConfig,
  inferProjectDomain,
  renderProjectCharter,
  summarizePersona,
} from "./persona.js";

interface CreateProjectFilesOptions {
  portfolio?: PortfolioEntry;
}

export function makeProjectId(projectRoot: string, explicitId?: string): string {
  if (explicitId) {
    return sanitizeId(explicitId);
  }

  const base = path.basename(projectRoot) || "project";
  return sanitizeId(base);
}

export function sanitizeId(input: string): string {
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "project"
  );
}

export function defaultBranchName(
  projectId: string,
  loopKind: LoopKind = "developer-debugger",
): string {
  return `devise/${projectId}/${builderRoleForLoopKind(loopKind)}`;
}

export function defaultProjectConfig(input: CreateProjectInput): ProjectConfig {
  return defaultProjectConfigWithPortfolio(input);
}

function defaultProjectConfigWithPortfolio(
  input: CreateProjectInput,
  portfolio?: PortfolioEntry,
): ProjectConfig {
  const projectId = makeProjectId(input.projectRoot, input.projectId);
  const projectRoot = path.resolve(input.projectRoot);
  const domain = inferProjectDomain(input, portfolio);
  const charter = generateProjectCharter(input, domain, portfolio);
  const bias = portfolio?.rolePersonaHints ?? {};

  if (input.loopKind === "scientist-modeller") {
    return {
      version: 3,
      kind: "managed_project",
      project: {
        id: projectId,
        root: projectRoot,
      },
      loop_kind: input.loopKind,
      domain,
      summary: charter.continuity_summary,
      charter,
      goal: input.goal,
      acceptance: charter.acceptance,
      commands: {
        setup: input.setupCommands ?? [],
        scientist_research:
          input.scientistResearchCommands ?? [
            'printf "Set commands.scientist_research in .devise/project.yaml\\n" && exit 1',
          ],
        modeller_design:
          input.modellerDesignCommands ?? [
            'printf "Set commands.modeller_design in .devise/project.yaml\\n" && exit 1',
          ],
        scientist_assess:
          input.scientistAssessCommands ?? [
            'printf "Set commands.scientist_assess in .devise/project.yaml\\n" && exit 1',
          ],
      },
      git: {
        role_branch: defaultBranchName(projectId, input.loopKind),
        commit_message_template: `role(${projectId}): modeller iteration {{iteration}}`,
      },
      loop: {
        max_iterations: 10,
        stagnation_limit: 2,
      },
      roles: {
        scientist: generateRoleConfig(
          "scientist",
          charter,
          "Synthesizes evidence, frames hypotheses, assesses model fitness, and decides whether the goal is met.",
          input.scientistSpecialization,
          bias.scientist,
        ),
        modeller: generateRoleConfig(
          "modeller",
          charter,
          "Chooses methods and tools, designs the analytic model, and commits model updates for assessment.",
          input.modellerSpecialization,
          bias.modeller,
        ),
      },
    };
  }

  return {
    version: 3,
    kind: "managed_project",
    project: {
      id: projectId,
      root: projectRoot,
    },
    loop_kind: input.loopKind,
    domain,
    summary: charter.continuity_summary,
    charter,
    goal: input.goal,
    acceptance: charter.acceptance,
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
      role_branch: defaultBranchName(projectId, input.loopKind),
      commit_message_template: `role(${projectId}): developer iteration {{iteration}}`,
    },
    loop: {
      max_iterations: 10,
      stagnation_limit: 2,
    },
    roles: {
      developer: generateRoleConfig(
        "developer",
        charter,
        "Patches code until dry-test passes and commits the result.",
        input.developerSpecialization,
        bias.developer,
      ),
      debugger: generateRoleConfig(
        "debugger",
        charter,
        "Runs the real use flow, writes a detailed report, and decides whether the goal is met.",
        input.debuggerSpecialization,
        bias.debugger,
      ),
    },
  };
}

export function defaultRuntimeState(
  projectConfig: ProjectConfig,
  controllerThreadId?: string,
): RuntimeState {
  return {
    version: projectConfig.version >= 3 ? 3 : 2,
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
  options: CreateProjectFilesOptions = {},
): Promise<{ project: ProjectConfig; runtime: RuntimeState }> {
  const root = path.resolve(input.projectRoot);
  const project = defaultProjectConfigWithPortfolio(
    { ...input, projectRoot: root },
    options.portfolio,
  );
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
    ".devise/watch-events.jsonl",
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
  await fs.writeFile(configPath, YAML.stringify(project), "utf8");
}

export async function loadRuntimeState(projectRoot: string): Promise<RuntimeState> {
  const project = await loadProjectConfig(projectRoot);
  const runtime = await readJsonFile(
    await resolveRuntimeStatePath(project.project.root),
    defaultRuntimeState(project),
  );
  return normalizeRuntimeState(project, runtime as Partial<RuntimeState>);
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

export function ensureRoleAllowedForProject(project: ProjectConfig, role: RoleKind): void {
  if (!isRoleAllowedForLoopKind(project.loop_kind, role)) {
    const active = activeRolesForProject(project).join(", ");
    throw new Error(
      `Role ${role} is not valid for ${project.loop_kind} projects (active roles: ${active})`,
    );
  }
}

export function activeRolesForProject(project: ProjectConfig): readonly [RoleKind, RoleKind] {
  return activeRolesForLoopKind(project.loop_kind);
}

export function renderProjectSpec(project: ProjectConfig): string {
  const acceptance = project.acceptance.map((item) => `- ${item}`).join("\n");
  const setup = renderCommandSection(project.commands.setup);
  const personas = renderRolePersonas(project.roles);
  const charter = renderProjectCharter(project);

  if (project.loop_kind === "scientist-modeller") {
    const scientistResearch = renderCommandSection(project.commands.scientist_research);
    const modellerDesign = renderCommandSection(project.commands.modeller_design);
    const scientistAssess = renderCommandSection(project.commands.scientist_assess);

    return `# Project Spec

## Loop Kind

scientist-modeller

## Project Charter

${charter}

## Acceptance Criteria

${acceptance}

## Role Personas

${personas}

## Setup Commands

${setup}

## Scientist Research Commands

${scientistResearch}

## Modeller Design Commands

${modellerDesign}

## Scientist Assessment Commands

${scientistAssess}
`;
  }

  const dryTest = renderCommandSection(project.commands.dry_test);
  const restart = renderCommandSection(project.commands.restart);
  const useFlow = renderCommandSection(project.commands.use);
  const monitor = renderCommandSection(project.commands.monitor);
  const monitorUntil = renderBulletList(project.commands.monitor_until);
  const monitorTimeout = project.commands.monitor_timeout_seconds ?? 300;

  return `# Project Spec

## Loop Kind

developer-debugger

## Project Charter

${charter}

## Acceptance Criteria

${acceptance}

## Role Personas

${personas}

## Setup Commands

${setup}

## Dry Test Commands

${dryTest}

## Debugger Clean Restart Commands

${restart}

## Real Use Commands

${useFlow}

## Debugger Monitor Commands

${monitor}

## Debugger Caveats To Watch For

${monitorUntil}

## Debugger Monitor Timeout Seconds

${monitorTimeout}
`;
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
  const currentDir = artifactsDir(resolvedRoot);
  if (await pathExists(currentDir)) {
    return currentDir;
  }

  const legacyDir = legacyArtifactsDir(resolvedRoot);
  if (await pathExists(legacyDir)) {
    return legacyDir;
  }

  return currentDir;
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

export async function resolveWatchEventsPath(projectRoot: string): Promise<string> {
  const resolvedRoot = path.resolve(projectRoot);
  const currentPath = watchEventsPath(resolvedRoot);
  if (await pathExists(currentPath)) {
    return currentPath;
  }

  const legacyPath = legacyWatchEventsPath(resolvedRoot);
  if (await pathExists(legacyPath)) {
    return legacyPath;
  }

  return currentPath;
}

function normalizeRuntimeState(
  project: ProjectConfig,
  runtime: Partial<RuntimeState>,
): RuntimeState {
  const fallback = defaultRuntimeState(project, runtime.controllerThreadId);
  return {
    ...fallback,
    ...runtime,
    version: project.version >= 3 ? 3 : 2,
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
  if (project?.version !== 2 && project?.version !== 3) {
    throw new Error(
      `Unsupported project config version at ${configPath}: expected version 2 or 3. Recreate or manually migrate this project.`,
    );
  }

  if (!project?.project?.id || !project?.project?.root) {
    throw new Error(`Invalid project config at ${configPath}: missing project.id or project.root`);
  }

  if (project.loop_kind !== "developer-debugger" && project.loop_kind !== "scientist-modeller") {
    throw new Error(`Invalid project config at ${configPath}: loop_kind must be a supported value`);
  }

  if (!Array.isArray(project.acceptance) || project.acceptance.length === 0) {
    throw new Error(`Invalid project config at ${configPath}: acceptance must be a non-empty list`);
  }

  const activeRoles = activeRolesForProject(project);
  for (const role of activeRoles) {
    if (!project.roles[role]?.description) {
      throw new Error(
        `Invalid project config at ${configPath}: roles.${role}.description is required for ${project.loop_kind}`,
      );
    }
  }

  if (project.version >= 3) {
    if (project.kind !== "managed_project") {
      throw new Error(`Invalid project config at ${configPath}: kind must be managed_project`);
    }
    if (!project.domain || !project.summary || !project.charter) {
      throw new Error(
        `Invalid project config at ${configPath}: version 3 projects require domain, summary, and charter`,
      );
    }
    for (const role of activeRoles) {
      const persona = project.roles[role]?.persona;
      if (
        !persona?.title ||
        !persona.domain ||
        !Array.isArray(persona.exemplars) ||
        persona.exemplars.length === 0 ||
        !Array.isArray(persona.methods) ||
        persona.methods.length === 0 ||
        !Array.isArray(persona.standards) ||
        persona.standards.length === 0 ||
        !persona.voice_brief ||
        !persona.hidden_instructions
      ) {
        throw new Error(
          `Invalid project config at ${configPath}: roles.${role}.persona is required and must be complete for version 3 projects`,
        );
      }
    }
  }

  if (project.loop_kind === "scientist-modeller") {
    assertNonEmptyCommandList(
      project.commands.scientist_research,
      configPath,
      "commands.scientist_research",
    );
    assertNonEmptyCommandList(
      project.commands.modeller_design,
      configPath,
      "commands.modeller_design",
    );
    assertNonEmptyCommandList(
      project.commands.scientist_assess,
      configPath,
      "commands.scientist_assess",
    );
    return;
  }

  assertNonEmptyCommandList(project.commands.dry_test, configPath, "commands.dry_test");
  assertNonEmptyCommandList(project.commands.use, configPath, "commands.use");
}

function assertNonEmptyCommandList(
  commands: string[] | undefined,
  configPath: string,
  fieldName: string,
): void {
  if (!Array.isArray(commands) || commands.length === 0) {
    throw new Error(`Invalid project config at ${configPath}: ${fieldName} must be a non-empty list`);
  }
}

function renderCommandSection(commands?: string[]): string {
  if (!commands || commands.length === 0) {
    return "- None configured.";
  }

  return commands.map((item) => `- \`${item}\``).join("\n");
}

function renderBulletList(items?: string[]): string {
  if (!items || items.length === 0) {
    return "- None configured.";
  }

  return items.map((item) => `- ${item}`).join("\n");
}

function renderRolePersonas(roles: Partial<Record<RoleKind, RoleConfig>>): string {
  const lines = Object.entries(roles).map(([role, config]) => {
    return `- ${roleTitle(role as RoleKind)}: ${summarizePersona(
      config?.persona,
      config?.specialization,
    )}`;
  });
  return lines.length > 0 ? lines.join("\n") : "- None configured.";
}

export function projectTitle(project: ProjectConfig): string {
  return project.charter?.title ?? project.goal;
}

export function projectDomain(project: ProjectConfig): string {
  return project.charter?.domain ?? project.domain ?? "Unknown";
}
