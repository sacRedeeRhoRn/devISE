import test from "node:test";
import assert from "node:assert/strict";

import { observableTurnEventsForTest, roleOutputSchemasForTest } from "../src/lib/controller.js";

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

test("observable turn events capture commentary and command progress without final JSON noise", () => {
  const events = observableTurnEventsForTest(
    {
      id: "turn-1",
      status: "inProgress",
      items: [
        {
          id: "item-1",
          type: "agentMessage",
          text: "Checking the current preflight behavior before patching.",
        },
        {
          id: "item-2",
          type: "commandExecution",
          status: "inProgress",
          command: "pytest -q tests/test_preflight_config.py",
        },
        {
          id: "item-3",
          type: "agentMessage",
          text: "{\"status\":\"green\"}",
        },
        {
          id: "item-4",
          type: "commandExecution",
          status: "completed",
          command: "pytest -q tests/test_preflight_config.py",
          aggregatedOutput: "3 passed\n",
        },
      ],
    },
    "developer",
    2,
    "thread-1",
  );

  assert.equal(events.length, 3);
  assert.equal(events[0]?.kind, "commentary");
  assert.match(events[0]?.message ?? "", /Checking the current preflight behavior/);
  assert.equal(events[1]?.kind, "command_started");
  assert.equal(events[2]?.kind, "command_finished");
  assert.match(events[2]?.outputPreview ?? "", /3 passed/);
});
