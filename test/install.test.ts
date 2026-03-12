import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  doctor,
  installAssets,
  removeNamedTomlTable,
  renderMcpBlock,
  upsertNamedTomlTable,
} from "../src/lib/install.js";
import {
  promptAliasInstallPath,
  promptFlightInstallPath,
  promptInstallPath,
  promptLandInstallPath,
} from "../src/lib/paths.js";

test("upsertNamedTomlTable appends missing table", () => {
  const initial = 'model = "gpt-5.4"\n';
  const block = renderMcpBlock("/tmp/devise.js");
  const updated = upsertNamedTomlTable(initial, "mcp_servers.devise", block);

  assert.match(updated, /\[mcp_servers\.devise\]/);
  assert.match(updated, /\/tmp\/devise\.js/);
});

test("upsertNamedTomlTable replaces existing managed block only once", () => {
  const first = `[mcp_servers.devise]
command = "node"
args = ["/old/path.js", "serve"]

[features]
apps = true
`;
  const updated = upsertNamedTomlTable(
    first,
    "mcp_servers.devise",
    renderMcpBlock("/new/path.js"),
  );

  assert.equal(updated.match(/\[mcp_servers\.devise\]/g)?.length, 1);
  assert.match(updated, /\/new\/path\.js/);
  assert.doesNotMatch(updated, /\/old\/path\.js/);
  assert.match(updated, /\[features\]/);
});

test("removeNamedTomlTable removes legacy block and preserves neighbors", () => {
  const initial = `[mcp_servers.codex_role]
command = "node"
args = ["/old/path.js", "serve"]

[features]
apps = true
`;
  const updated = removeNamedTomlTable(initial, "mcp_servers.codex_role");

  assert.doesNotMatch(updated, /\[mcp_servers\.codex_role\]/);
  assert.match(updated, /\[features\]/);
});

test("installAssets and doctor cover role, alias, flight, and land prompts", async () => {
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "devise-codex-home-"));
  const originalCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;

  try {
    await installAssets(process.cwd(), "/tmp/devise-cli.js");
    const findings = await doctor(process.cwd(), "/tmp/devise-cli.js");

    await assert.doesNotReject(() => fs.access(promptInstallPath()));
    await assert.doesNotReject(() => fs.access(promptAliasInstallPath()));
    await assert.doesNotReject(() => fs.access(promptFlightInstallPath()));
    await assert.doesNotReject(() => fs.access(promptLandInstallPath()));

    assert(findings.some((line) => line.includes("OK prompt installed")));
    assert(findings.some((line) => line.includes("OK prompt alias installed")));
    assert(findings.some((line) => line.includes("OK flight prompt installed")));
    assert(findings.some((line) => line.includes("OK land prompt installed")));
  } finally {
    if (originalCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = originalCodexHome;
    }
    await fs.rm(codexHome, { recursive: true, force: true });
  }
});
