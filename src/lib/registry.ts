import { readJsonFile, writeJsonFile } from "./fs.js";
import { legacyRegistryPath, registryPath } from "./paths.js";
import type { ProjectConfig, RegistryEntry, RegistryFile } from "./types.js";

const EMPTY_REGISTRY: RegistryFile = {
  version: 1,
  projects: [],
};

export async function loadRegistry(): Promise<RegistryFile> {
  const [current, legacy] = await Promise.all([
    readJsonFile(registryPath(), EMPTY_REGISTRY),
    readJsonFile(legacyRegistryPath(), EMPTY_REGISTRY),
  ]);

  const merged = mergeRegistryFiles(current, legacy);
  if (merged.projects.length > 0 && JSON.stringify(merged) !== JSON.stringify(current)) {
    await writeJsonFile(registryPath(), merged);
  }
  return merged;
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

function mergeRegistryFiles(...registries: RegistryFile[]): RegistryFile {
  const byKey = new Map<string, RegistryEntry>();

  for (const registry of registries) {
    for (const entry of registry.projects) {
      const key = `${entry.id}\u0000${entry.root}`;
      const existing = byKey.get(key);
      if (!existing || existing.updatedAt.localeCompare(entry.updatedAt) < 0) {
        byKey.set(key, entry);
      }
    }
  }

  return {
    version: 1,
    projects: [...byKey.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
  };
}
