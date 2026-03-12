import test from "node:test";
import assert from "node:assert/strict";

import { removeNamedTomlTable, renderMcpBlock, upsertNamedTomlTable } from "../src/lib/install.js";

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
