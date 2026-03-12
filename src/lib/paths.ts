import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

export function repoRootFromModule(metaUrl: string): string {
  return path.resolve(path.dirname(fileURLToPath(metaUrl)), "..", "..");
}

export function expandHome(input: string): string {
  if (input === "~") {
    return os.homedir();
  }

  if (input.startsWith("~/")) {
    return path.join(os.homedir(), input.slice(2));
  }

  return input;
}

export function codexHome(): string {
  return process.env.CODEX_HOME
    ? expandHome(process.env.CODEX_HOME)
    : path.join(os.homedir(), ".codex");
}

export function codexRoleHome(): string {
  return path.join(os.homedir(), ".codex-role");
}

export function deviseHome(): string {
  return path.join(os.homedir(), ".devise");
}

export function promptInstallPath(): string {
  return path.join(codexHome(), "prompts", "role.md");
}

export function promptAliasInstallPath(): string {
  return path.join(codexHome(), "prompts", "devise.md");
}

export function promptFlightInstallPath(): string {
  return path.join(codexHome(), "prompts", "devise-flight.md");
}

export function promptLandInstallPath(): string {
  return path.join(codexHome(), "prompts", "devise-land.md");
}

export function skillInstallRoot(): string {
  return path.join(codexHome(), "skills", "role-project-planner");
}

export function skillAliasInstallRoot(): string {
  return path.join(codexHome(), "skills", "devise-project-planner");
}

export function mcpConfigPath(): string {
  return path.join(codexHome(), "config.toml");
}

export function registryPath(): string {
  return path.join(deviseHome(), "registry.json");
}

export function legacyRegistryPath(): string {
  return path.join(codexRoleHome(), "registry.json");
}

export function projectStateDir(projectRoot: string): string {
  return path.join(projectRoot, ".devise");
}

export function legacyProjectStateDir(projectRoot: string): string {
  return path.join(projectRoot, ".codex-role");
}

export function projectConfigPath(projectRoot: string): string {
  return path.join(projectStateDir(projectRoot), "project.yaml");
}

export function legacyProjectConfigPath(projectRoot: string): string {
  return path.join(legacyProjectStateDir(projectRoot), "project.yaml");
}

export function runtimeStatePath(projectRoot: string): string {
  return path.join(projectStateDir(projectRoot), "runtime.json");
}

export function legacyRuntimeStatePath(projectRoot: string): string {
  return path.join(legacyProjectStateDir(projectRoot), "runtime.json");
}

export function artifactsDir(projectRoot: string): string {
  return path.join(projectStateDir(projectRoot), "artifacts");
}

export function legacyArtifactsDir(projectRoot: string): string {
  return path.join(legacyProjectStateDir(projectRoot), "artifacts");
}

export function controllerLogPath(projectRoot: string): string {
  return path.join(projectStateDir(projectRoot), "controller.log");
}

export function legacyControllerLogPath(projectRoot: string): string {
  return path.join(legacyProjectStateDir(projectRoot), "controller.log");
}

export function watchEventsPath(projectRoot: string): string {
  return path.join(projectStateDir(projectRoot), "watch-events.jsonl");
}

export function legacyWatchEventsPath(projectRoot: string): string {
  return path.join(legacyProjectStateDir(projectRoot), "watch-events.jsonl");
}

export function specPath(projectRoot: string): string {
  return path.join(projectRoot, "PROJECT_SPEC.md");
}
