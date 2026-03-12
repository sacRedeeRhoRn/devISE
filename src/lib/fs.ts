import fs from "node:fs/promises";
import path from "node:path";

export async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

export async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function readJsonFile<T>(
  filePath: string,
  fallback: T,
): Promise<T> {
  if (!(await pathExists(filePath))) {
    return fallback;
  }

  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw) as T;
}

export async function writeJsonFile(
  filePath: string,
  data: unknown,
): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

export async function readTextIfExists(filePath: string): Promise<string> {
  if (!(await pathExists(filePath))) {
    return "";
  }

  return fs.readFile(filePath, "utf8");
}

export async function appendUniqueLines(
  filePath: string,
  lines: string[],
): Promise<void> {
  const existing = await readTextIfExists(filePath);
  const normalized = new Set(
    existing
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
  );

  const toAppend = lines.filter((line) => !normalized.has(line.trim()));
  if (toAppend.length === 0) {
    return;
  }

  const prefix =
    existing.length === 0 || existing.endsWith("\n") ? existing : `${existing}\n`;
  const next = `${prefix}${toAppend.join("\n")}\n`;
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, next, "utf8");
}
