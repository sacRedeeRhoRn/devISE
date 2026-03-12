import fs from "node:fs/promises";
import path from "node:path";

import { ensureDir, pathExists } from "./fs.js";
import { mcpConfigPath, promptInstallPath, skillInstallRoot } from "./paths.js";

const MCP_SERVER_BLOCK_NAME = "devise";

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

  await copyDir(skillSource, skillInstallRoot());
  await installMcpConfig(cliEntrypoint);

  return {
    promptPath: promptInstallPath(),
    skillPath: skillInstallRoot(),
    configPath: mcpConfigPath(),
  };
}

export async function doctor(repoRoot: string, cliEntrypoint: string): Promise<string[]> {
  const promptPath = promptInstallPath();
  const skillPath = skillInstallRoot();
  const configPath = mcpConfigPath();
  const findings: string[] = [];

  findings.push(
    (await pathExists(promptPath))
      ? `OK prompt installed at ${promptPath}`
      : `MISSING prompt at ${promptPath}`,
  );
  findings.push(
    (await pathExists(path.join(skillPath, "SKILL.md")))
      ? `OK skill installed at ${skillPath}`
      : `MISSING skill at ${skillPath}`,
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
  const updated = upsertNamedTomlTable(existing, `mcp_servers.${MCP_SERVER_BLOCK_NAME}`, block);
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
  return raw.includes(`[mcp_servers.${MCP_SERVER_BLOCK_NAME}]`) && raw.includes(cliEntrypoint);
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
