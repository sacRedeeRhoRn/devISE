import test from "node:test";
import assert from "node:assert/strict";

import { roleOutputSchemasForTest } from "../src/lib/controller.js";

test("role output schemas require every property and allow nullable optional fields", () => {
  for (const schema of Object.values(roleOutputSchemasForTest)) {
    const required = new Set((schema.required as string[]) ?? []);
    const properties = schema.properties as Record<string, Record<string, unknown>>;
    assert.deepEqual(new Set(Object.keys(properties)), required);
  }

  const developerProperties = roleOutputSchemasForTest.developer.properties as Record<
    string,
    Record<string, unknown>
  >;
  const debuggerProperties = roleOutputSchemasForTest.debugger.properties as Record<
    string,
    Record<string, unknown>
  >;

  assert.deepEqual(developerProperties.commit_sha?.type, ["string", "null"]);
  assert.deepEqual(developerProperties.blocking_reason?.type, ["string", "null"]);
  assert.deepEqual(debuggerProperties.observed_caveat?.type, ["string", "null"]);
  assert.deepEqual(debuggerProperties.blocking_reason?.type, ["string", "null"]);
});
