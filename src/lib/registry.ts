import { readJsonFile, writeJsonFile } from "./fs.js";
import { registryPath } from "./paths.js";
import type { ProjectConfig, RegistryEntry, RegistryFile } from "./types.js";

const EMPTY_REGISTRY: RegistryFile = {
  version: 1,
  projects: [],
};

export async function loadRegistry(): Promise<RegistryFile> {
  return readJsonFile(registryPath(), EMPTY_REGISTRY);
}

export async function upsertRegistryEntry(project: ProjectConfig): Promise<RegistryEntry> {
  const registry = await loadRegistry();
  const now = new Date().toISOString();
  const next: RegistryEntry = {
    id: project.project.id,
    root: project.project.root,
    goal: project.goal,
    createdAt: now,
    updatedAt: now,
  };

  const existingIndex = registry.projects.findIndex(
    (entry) => entry.id === project.project.id || entry.root === project.project.root,
  );

  if (existingIndex >= 0) {
    const existing = registry.projects[existingIndex]!;
    registry.projects[existingIndex] = {
      ...existing,
      ...next,
      createdAt: existing.createdAt,
    };
  } else {
    registry.projects.push(next);
  }

  registry.projects.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  await writeJsonFile(registryPath(), registry);
  return registry.projects.find((entry) => entry.id === project.project.id)!;
}
