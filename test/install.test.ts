import test from "node:test";
import assert from "node:assert/strict";

import { renderMcpBlock, upsertNamedTomlTable } from "../src/lib/install.js";

test("upsertNamedTomlTable appends missing table", () => {
  const initial = 'model = "gpt-5.4"\n';
  const block = renderMcpBlock("/tmp/codex-role.js");
  const updated = upsertNamedTomlTable(initial, "mcp_servers.codex_role", block);

  assert.match(updated, /\[mcp_servers\.codex_role\]/);
  assert.match(updated, /\/tmp\/codex-role\.js/);
});

test("upsertNamedTomlTable replaces existing managed block only once", () => {
  const first = `[mcp_servers.codex_role]
command = "node"
args = ["/old/path.js", "serve"]

[features]
apps = true
`;
  const updated = upsertNamedTomlTable(
    first,
    "mcp_servers.codex_role",
    renderMcpBlock("/new/path.js"),
  );

  assert.equal(updated.match(/\[mcp_servers\.codex_role\]/g)?.length, 1);
  assert.match(updated, /\/new\/path\.js/);
  assert.doesNotMatch(updated, /\/old\/path\.js/);
  assert.match(updated, /\[features\]/);
});
