import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { CodexAppServerClient } from "../src/lib/appServerClient.js";

test("CodexAppServerClient initializes once and serves requests", async () => {
  const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "devise-fake-codex-"));
  const codexPath = path.join(binDir, "codex");
  const originalPath = process.env.PATH ?? "";

  await fs.writeFile(
    codexPath,
    `#!/usr/bin/env node
process.stdin.setEncoding("utf8");
let buffer = "";

function respond(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

function handleLine(line) {
  if (!line.trim()) {
    return;
  }
  const request = JSON.parse(line);
  if (request.method === "initialize") {
    respond({ jsonrpc: "2.0", id: request.id, result: {} });
    return;
  }
  if (request.method === "initialized") {
    return;
  }
  if (request.method === "thread/list") {
    respond({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        data: [
          {
            id: "thread-1",
            preview: "preview",
            updatedAt: 0,
            cwd: process.cwd(),
            source: "cli",
            name: null,
            agentRole: null,
            turns: [],
          },
        ],
      },
    });
    return;
  }
  respond({
    jsonrpc: "2.0",
    id: request.id,
    error: {
      code: -32601,
      message: "unsupported",
    },
  });
}

process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (buffer.includes("\\n")) {
    const index = buffer.indexOf("\\n");
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    handleLine(line);
  }
});
`,
    "utf8",
  );
  await fs.chmod(codexPath, 0o755);

  process.env.PATH = `${binDir}:${originalPath}`;
  const client = new CodexAppServerClient();

  try {
    const threads = await client.listThreads({ cwd: process.cwd() });
    assert.equal(threads.length, 1);
    assert.equal(threads[0]?.id, "thread-1");
  } finally {
    process.env.PATH = originalPath;
    await client.close();
    await fs.rm(binDir, { recursive: true, force: true });
  }
});
