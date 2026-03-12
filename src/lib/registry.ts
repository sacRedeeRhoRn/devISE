import { readJsonFile, writeJsonFile } from "./fs.js";
import { sanitizeId } from "./project.js";
import { legacyRegistryPath, registryPath } from "./paths.js";
import type {
  CreatePortfolioInput,
  ManagedProjectRegistryEntry,
  PortfolioEntry,
  ProjectConfig,
  RegistryEntry,
  RegistryFile,
  RoleKind,
} from "./types.js";

const EMPTY_REGISTRY: RegistryFile = {
  version: 2,
  projects: [],
};

type LegacyRegistryEntry = {
  id: string;
  root: string;
  goal: string;
  createdAt: string;
  updatedAt: string;
};

type LegacyRegistryFile = {
  version?: number;
  projects?: LegacyRegistryEntry[];
};

export async function loadRegistry(): Promise<RegistryFile> {
  const [currentRaw, legacyRaw] = await Promise.all([
    readJsonFile(registryPath(), EMPTY_REGISTRY as unknown as Record<string, unknown>),
    readJsonFile(legacyRegistryPath(), { version: 1, projects: [] } as unknown as Record<string, unknown>),
  ]);

  const current = normalizeRegistryFile(currentRaw);
  const legacy = normalizeLegacyRegistryFile(legacyRaw as LegacyRegistryFile);
  const merged = mergeRegistryFiles(current, legacy);
  if (JSON.stringify(merged) !== JSON.stringify(current)) {
    await writeJsonFile(registryPath(), merged);
  }
  return merged;
}

export async function upsertRegistryEntry(
  project: ProjectConfig,
  parentId?: string,
): Promise<ManagedProjectRegistryEntry> {
  const registry = await loadRegistry();
  const now = new Date().toISOString();
  const next: ManagedProjectRegistryEntry = {
    id: project.project.id,
    kind: "managed_project",
    root: project.project.root,
    goal: project.goal,
    summary: project.summary ?? project.charter?.continuity_summary ?? project.goal,
    domain: project.domain ?? project.charter?.domain,
    parentId,
    createdAt: now,
    updatedAt: now,
  };

  const existingIndex = registry.projects.findIndex(
    (entry) =>
      entry.kind === "managed_project" &&
      (entry.id === project.project.id || entry.root === project.project.root),
  );

  if (existingIndex >= 0) {
    const existing = registry.projects[existingIndex] as ManagedProjectRegistryEntry;
    registry.projects[existingIndex] = {
      ...existing,
      ...next,
      createdAt: existing.createdAt,
    };
  } else {
    registry.projects.push(next);
  }

  await persistRegistry(registry);
  return registry.projects.find(
    (entry): entry is ManagedProjectRegistryEntry =>
      entry.kind === "managed_project" && entry.id === project.project.id,
  )!;
}

export async function createPortfolioEntry(
  input: CreatePortfolioInput,
): Promise<PortfolioEntry> {
  const registry = await loadRegistry();
  const now = new Date().toISOString();
  const entry: PortfolioEntry = {
    id: sanitizeId(input.portfolioId ?? input.title),
    kind: "portfolio",
    title: input.title.trim(),
    goal: input.goal.trim(),
    summary: input.summary?.trim() || input.goal.trim(),
    sharedContextSummary: input.summary?.trim() || input.goal.trim(),
    domain: input.domain?.trim() || undefined,
    rolePersonaHints: roleHintsFromInput(input),
    createdAt: now,
    updatedAt: now,
  };

  const existingIndex = registry.projects.findIndex(
    (candidate) => candidate.id === entry.id,
  );
  if (existingIndex >= 0) {
    const existing = registry.projects[existingIndex];
    if (existing?.kind !== "portfolio") {
      throw new Error(`Registry id ${entry.id} is already used by a managed project`);
    }
    registry.projects[existingIndex] = {
      ...existing,
      ...entry,
      createdAt: existing.createdAt,
    };
  } else {
    registry.projects.push(entry);
  }

  await persistRegistry(registry);
  return registry.projects.find(
    (candidate): candidate is PortfolioEntry =>
      candidate.kind === "portfolio" && candidate.id === entry.id,
  )!;
}

export async function moveManagedProject(
  projectId: string,
  newParentId?: string | null,
): Promise<ManagedProjectRegistryEntry> {
  const registry = await loadRegistry();
  const projectIndex = registry.projects.findIndex(
    (entry) => entry.kind === "managed_project" && entry.id === projectId,
  );
  if (projectIndex < 0) {
    throw new Error(`Managed project ${projectId} was not found in the registry`);
  }

  if (newParentId) {
    const parent = registry.projects.find(
      (entry) => entry.kind === "portfolio" && entry.id === newParentId,
    );
    if (!parent) {
      throw new Error(`Portfolio ${newParentId} was not found in the registry`);
    }
  }

  const entry = registry.projects[projectIndex] as ManagedProjectRegistryEntry;
  registry.projects[projectIndex] = {
    ...entry,
    parentId: newParentId || undefined,
    updatedAt: new Date().toISOString(),
  };
  await persistRegistry(registry);
  return registry.projects[projectIndex] as ManagedProjectRegistryEntry;
}

export async function findRegistryEntryById(id: string): Promise<RegistryEntry | undefined> {
  const registry = await loadRegistry();
  return registry.projects.find((entry) => entry.id === id);
}

function normalizeRegistryFile(raw: unknown): RegistryFile {
  if (!raw || typeof raw !== "object") {
    return EMPTY_REGISTRY;
  }

  const maybe = raw as { version?: number; projects?: unknown[] };
  if (maybe.version === 2 && Array.isArray(maybe.projects)) {
    return {
      version: 2,
      projects: maybe.projects.filter(isRegistryEntry),
    };
  }

  if (Array.isArray(maybe.projects)) {
    return normalizeLegacyRegistryFile(raw as LegacyRegistryFile);
  }

  return EMPTY_REGISTRY;
}

function normalizeLegacyRegistryFile(raw: LegacyRegistryFile): RegistryFile {
  return {
    version: 2,
    projects: (raw.projects ?? [])
      .filter((entry): entry is LegacyRegistryEntry => Boolean(entry?.id && entry?.root))
      .map((entry) => ({
        id: entry.id,
        kind: "managed_project",
        root: entry.root,
        goal: entry.goal,
        summary: entry.goal,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
      })),
  };
}

function mergeRegistryFiles(...registries: RegistryFile[]): RegistryFile {
  const byKey = new Map<string, RegistryEntry>();

  for (const registry of registries) {
    for (const entry of registry.projects) {
      const key =
        entry.kind === "managed_project"
          ? `${entry.kind}\u0000${entry.id}\u0000${entry.root}`
          : `${entry.kind}\u0000${entry.id}`;
      const existing = byKey.get(key);
      if (!existing || existing.updatedAt.localeCompare(entry.updatedAt) < 0) {
        byKey.set(key, entry);
      }
    }
  }

  return {
    version: 2,
    projects: [...byKey.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
  };
}

async function persistRegistry(registry: RegistryFile): Promise<void> {
  registry.projects.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  await writeJsonFile(registryPath(), registry);
}

function roleHintsFromInput(
  input: CreatePortfolioInput,
): Partial<Record<RoleKind, string>> | undefined {
  const hints: Partial<Record<RoleKind, string>> = {
    developer: input.developerPersonaHint?.trim() || undefined,
    debugger: input.debuggerPersonaHint?.trim() || undefined,
    scientist: input.scientistPersonaHint?.trim() || undefined,
    modeller: input.modellerPersonaHint?.trim() || undefined,
  };
  return Object.values(hints).some(Boolean) ? hints : undefined;
}

function isRegistryEntry(value: unknown): value is RegistryEntry {
  if (!value || typeof value !== "object") {
    return false;
  }

  const entry = value as Partial<RegistryEntry>;
  if (!entry.id || !entry.kind || !entry.goal || !entry.summary || !entry.createdAt || !entry.updatedAt) {
    return false;
  }

  if (entry.kind === "managed_project") {
    return Boolean((entry as Partial<ManagedProjectRegistryEntry>).root);
  }

  if (entry.kind === "portfolio") {
    return Boolean((entry as Partial<PortfolioEntry>).title);
  }

  return false;
}
