import fs from "node:fs/promises";
import path from "node:path";

import { ensureDir, pathExists } from "./fs.js";
import {
  mcpConfigPath,
  promptAliasInstallPath,
  promptInstallPath,
  skillAliasInstallRoot,
  skillInstallRoot,
} from "./paths.js";

const MCP_SERVER_BLOCK_NAME = "devise";
const LEGACY_MCP_SERVER_BLOCK_NAME = "codex_role";

export interface InstallResult {
  promptPath: string;
  skillPath: string;
  configPath: string;
}

export async function installAssets(repoRoot: string, cliEntrypoint: string): Promise<InstallResult> {
  const promptSource = path.join(repoRoot, "assets", "prompts", "devise.md");
  const skillSource = path.join(repoRoot, "assets", "skills", "devise-project-planner");

  await ensureDir(path.dirname(promptInstallPath()));
  await fs.copyFile(promptSource, promptInstallPath());
  await fs.copyFile(promptSource, promptAliasInstallPath());

  await copyDir(skillSource, skillInstallRoot());
  await copyDir(skillSource, skillAliasInstallRoot());
  await installMcpConfig(cliEntrypoint);

  return {
    promptPath: promptInstallPath(),
    skillPath: skillInstallRoot(),
    configPath: mcpConfigPath(),
  };
}

export async function doctor(repoRoot: string, cliEntrypoint: string): Promise<string[]> {
  const promptPath = promptInstallPath();
  const promptAliasPath = promptAliasInstallPath();
  const skillPath = skillInstallRoot();
  const skillAliasPath = skillAliasInstallRoot();
  const configPath = mcpConfigPath();
  const findings: string[] = [];

  findings.push(
    (await pathExists(promptPath))
      ? `OK prompt installed at ${promptPath}`
      : `MISSING prompt at ${promptPath}`,
  );
  findings.push(
    (await pathExists(promptAliasPath))
      ? `OK prompt alias installed at ${promptAliasPath}`
      : `MISSING prompt alias at ${promptAliasPath}`,
  );
  findings.push(
    (await pathExists(path.join(skillPath, "SKILL.md")))
      ? `OK skill installed at ${skillPath}`
      : `MISSING skill at ${skillPath}`,
  );
  findings.push(
    (await pathExists(path.join(skillAliasPath, "SKILL.md")))
      ? `OK skill alias installed at ${skillAliasPath}`
      : `MISSING skill alias at ${skillAliasPath}`,
  );
  findings.push(
    (await configContainsManagedServer(configPath, cliEntrypoint))
      ? `OK MCP server configured in ${configPath}`
      : `MISSING MCP server block in ${configPath}`,
  );
  findings.push(
    (await pathExists(path.join(repoRoot, "assets", "prompts", "devise.md")))
      ? `OK local prompt asset present`
      : `MISSING local prompt asset`,
  );

  return findings;
}

export async function installMcpConfig(cliEntrypoint: string): Promise<void> {
  const configPath = mcpConfigPath();
  const existing = (await pathExists(configPath))
    ? await fs.readFile(configPath, "utf8")
    : "";
  const block = renderMcpBlock(cliEntrypoint);
  const withManagedBlock = upsertNamedTomlTable(
    existing,
    `mcp_servers.${MCP_SERVER_BLOCK_NAME}`,
    block,
  );
  const updated = removeNamedTomlTable(
    withManagedBlock,
    `mcp_servers.${LEGACY_MCP_SERVER_BLOCK_NAME}`,
  );
  await ensureDir(path.dirname(configPath));
  await fs.writeFile(configPath, updated, "utf8");
}

export function renderMcpBlock(cliEntrypoint: string): string {
  const escapedEntry = cliEntrypoint.replace(/\\/g, "\\\\");
  return `[mcp_servers.${MCP_SERVER_BLOCK_NAME}]
command = "node"
args = ["${escapedEntry}", "serve"]
`;
}

export function upsertNamedTomlTable(
  existing: string,
  tableName: string,
  tableBlock: string,
): string {
  const block = tableBlock.endsWith("\n") ? tableBlock : `${tableBlock}\n`;
  const header = `[${tableName}]`;
  const start = existing.indexOf(header);
  if (start >= 0) {
    const remainder = existing.slice(start + header.length);
    const nextHeaderOffset = remainder.search(/\n\[[^\]]+\]/);
    const end =
      nextHeaderOffset >= 0
        ? start + header.length + nextHeaderOffset + 1
        : existing.length;
    const replaced = `${existing.slice(0, start)}${block}${existing.slice(end).replace(/^\n+/, "")}`;
    return replaced.endsWith("\n") ? replaced : `${replaced}\n`;
  }

  if (existing.trim().length === 0) {
    return block;
  }

  return `${existing.trimEnd()}\n\n${block}`;
}

async function configContainsManagedServer(
  configPath: string,
  cliEntrypoint: string,
): Promise<boolean> {
  if (!(await pathExists(configPath))) {
    return false;
  }

  const raw = await fs.readFile(configPath, "utf8");
  return (
    (raw.includes(`[mcp_servers.${MCP_SERVER_BLOCK_NAME}]`) ||
      raw.includes(`[mcp_servers.${LEGACY_MCP_SERVER_BLOCK_NAME}]`)) &&
    raw.includes(cliEntrypoint)
  );
}

export function removeNamedTomlTable(existing: string, tableName: string): string {
  const header = `[${tableName}]`;
  const start = existing.indexOf(header);
  if (start < 0) {
    return existing;
  }

  const remainder = existing.slice(start + header.length);
  const nextHeaderOffset = remainder.search(/\n\[[^\]]+\]/);
  const end =
    nextHeaderOffset >= 0
      ? start + header.length + nextHeaderOffset + 1
      : existing.length;
  const updated = `${existing.slice(0, start).replace(/\n+$/, "\n")}${existing
    .slice(end)
    .replace(/^\n+/, "")}`;
  return updated.trim().length === 0 ? "" : `${updated.trimEnd()}\n`;
}

async function copyDir(sourceDir: string, targetDir: string): Promise<void> {
  await ensureDir(targetDir);
  const entries = await fs.readdir(sourceDir, { withFileTypes: true });

  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      await copyDir(sourcePath, targetPath);
      continue;
    }

    await ensureDir(path.dirname(targetPath));
    await fs.copyFile(sourcePath, targetPath);
  }
}
