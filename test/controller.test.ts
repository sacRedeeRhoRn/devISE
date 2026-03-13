import test from "node:test";
import assert from "node:assert/strict";

import {
  connectivityIssueFromTextsForTest,
  isMissingRolloutErrorForTest,
  observableTurnEventsForTest,
  roleOutputSchemasForTest,
} from "../src/lib/controller.js";

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
  const scientistProperties = roleOutputSchemasForTest.scientist.properties as Record<
    string,
    Record<string, unknown>
  >;
  const modellerProperties = roleOutputSchemasForTest.modeller.properties as Record<
    string,
    Record<string, unknown>
  >;

  assert.deepEqual(developerProperties.commit_sha?.type, ["string", "null"]);
  assert.deepEqual(developerProperties.blocking_reason?.type, ["string", "null"]);
  assert.deepEqual(debuggerProperties.observed_caveat?.type, ["string", "null"]);
  assert.deepEqual(debuggerProperties.blocking_reason?.type, ["string", "null"]);
  assert.deepEqual(scientistProperties.blocking_reason?.type, ["string", "null"]);
  assert.equal(scientistProperties.assessment_passed?.type, "boolean");
  assert.deepEqual(modellerProperties.commit_sha?.type, ["string", "null"]);
  assert.equal(modellerProperties.design_ready?.type, "boolean");
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

test("observable turn events promote reasoning snapshots into structured events", () => {
  const events = observableTurnEventsForTest(
    {
      id: "turn-2",
      status: "inProgress",
      items: [
        {
          id: "item-1",
          type: "agentMessage",
          text: [
            'REASONING-SNAPSHOT {"intent":"confirm restart stability","current_step":"comparing the staged restart path with the live process state","finding_or_risk":"the restart path may leave a stale worker behind","blocker":"worker pid is still present after restart","next_action":"inspect the process table after restart"}',
            "Inspecting the process table before deciding whether the restart logic is safe.",
          ].join("\n"),
        },
      ],
    },
    "debugger",
    4,
    "thread-2",
  );

  assert.equal(events.length, 2);
  assert.equal(events[0]?.kind, "reasoning_snapshot");
  assert.equal(events[0]?.reasoning?.intent, "confirm restart stability");
  assert.match(events[0]?.message ?? "", /restart path/);
  assert.equal(events[1]?.kind, "commentary");
  assert.match(events[1]?.message ?? "", /Inspecting the process table/);
});

test("observable turn events promote reasoning snapshots into structured events", () => {
  const events = observableTurnEventsForTest(
    {
      id: "turn-2",
      status: "inProgress",
      items: [
        {
          id: "item-1",
          type: "agentMessage",
          text: [
            'REASONING-SNAPSHOT {"intent":"Verify runtime health","current_step":"Check the watch stream","finding_or_risk":"watch stream is healthy","next_action":"keep monitoring"}',
            "Keeping an eye on controller churn while the run is active.",
          ].join("\n"),
        },
      ],
    },
    "debugger",
    3,
    "thread-2",
  );

  assert.equal(events.length, 2);
  assert.equal(events[0]?.kind, "reasoning_snapshot");
  assert.equal(events[0]?.reasoning?.current_step, "Check the watch stream");
  assert.equal(events[1]?.kind, "commentary");
  assert.match(events[1]?.message ?? "", /controller churn/);
});

test("connectivity issue detection recognizes transient outage signals but ignores normal blockers", () => {
  const transient = connectivityIssueFromTextsForTest([
    "ssh: Could not resolve hostname cluster.example.org: Temporary failure in name resolution",
  ]);
  const normal = connectivityIssueFromTextsForTest([
    "Acceptance criteria are not met yet because the parity delta is still too large.",
  ]);

  assert.match(transient ?? "", /Temporary failure in name resolution/);
  assert.equal(normal, undefined);
});

test("missing rollout detection recognizes stale assigned sessions", () => {
  assert.equal(
    isMissingRolloutErrorForTest(
      new Error("no rollout found for thread id 019ce3b1-bb5b-7c51-a428-9097cc04a82b (code -32600)"),
    ),
    true,
  );
  assert.equal(
    isMissingRolloutErrorForTest(
      new Error("Acceptance criteria are not met yet"),
    ),
    false,
  );
});
