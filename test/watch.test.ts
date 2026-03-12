import test from "node:test";
import assert from "node:assert/strict";

import { buildWatchModel, parseControllerLogFallback, parseWatchEventsText } from "../src/lib/watch.js";
import type { RuntimeState, WatchEventRecord } from "../src/lib/types.js";

test("parseWatchEventsText keeps structured events in chronological order", () => {
  const events = parseWatchEventsText(
    [
      JSON.stringify({
        version: 1,
        at: "2026-03-13T02:10:00.000Z",
        kind: "turn_completed",
        role: "developer",
        message: "Developer finished the patch",
      } satisfies WatchEventRecord),
      JSON.stringify({
        version: 1,
        at: "2026-03-13T02:09:00.000Z",
        kind: "turn_started",
        role: "scientist",
        message: "Scientist turn started",
      } satisfies WatchEventRecord),
    ].join("\n"),
  );

  assert.equal(events.length, 2);
  assert.equal(events[0]?.kind, "turn_started");
  assert.equal(events[1]?.kind, "turn_completed");
});

test("parseControllerLogFallback detects all role names", () => {
  const events = parseControllerLogFallback(
    "2026-03-13T02:10:00.000Z iter=2 role=scientist event=turn_completed status=blocked message=\"Scientist blocked\"\n",
  );

  assert.equal(events.length, 1);
  assert.equal(events[0]?.kind, "turn_completed");
  assert.equal(events[0]?.role, "scientist");
  assert.match(events[0]?.message ?? "", /Scientist blocked/);
});

test("buildWatchModel prioritizes live feed, timeline, and active role snapshots", () => {
  const runtime: RuntimeState = {
    version: 2,
    projectId: "demo",
    projectRoot: "/tmp/demo",
    roles: {
      scientist: {
        role: "scientist",
        threadId: "scientist-thread",
        threadName: "devISE:demo:scientist",
        sourceMode: "current",
        assignedAt: "2026-03-13T02:00:00.000Z",
      },
      modeller: {
        role: "modeller",
        threadId: "modeller-thread",
        threadName: "devISE:demo:modeller",
        sourceMode: "current",
        assignedAt: "2026-03-13T02:00:00.000Z",
      },
    },
    launch: {},
    loop: {
      status: "running",
      iteration: 3,
      task: "Refine the analytic transport model",
      startRole: "scientist",
      lastRole: "modeller",
      lastCommitSha: "abcdef1234567890",
    },
    history: [
      {
        iteration: 1,
        role: "scientist",
        status: "needs_model_changes",
        summary: "Scientist framed the missing evidence and acceptance gap.",
        artifactPath: "/tmp/demo/.devise/artifacts/iter-001/scientist-assessment.md",
        at: "2026-03-13T02:01:00.000Z",
      },
      {
        iteration: 2,
        role: "modeller",
        status: "model_ready",
        summary: "Modeller revised the analytic model for the next assessment.",
        artifactPath: "/tmp/demo/.devise/artifacts/iter-002/modeller-design-report.md",
        commitSha: "abcdef1234567890",
        at: "2026-03-13T02:05:00.000Z",
      },
    ],
  };

  const model = buildWatchModel(
    {
      projectId: "demo",
      projectRoot: "/tmp/demo",
      runtime,
      roleA: "scientist",
      roleB: "modeller",
      controllerAlive: true,
      events: [
        {
          version: 1,
          at: "2026-03-13T02:06:00.000Z",
          kind: "command_started",
          role: "scientist",
          iteration: 3,
          message: "Scientist running assessment notes",
          command: "python assess_model.py",
        },
        {
          version: 1,
          at: "2026-03-13T02:06:30.000Z",
          kind: "commentary",
          role: "scientist",
          iteration: 3,
          message: "Re-checking whether the revised model now clears the acceptance bar.",
        },
      ],
      roleARecord: runtime.history[0],
      roleBRecord: runtime.history[1],
      roleAPreview: ["# Scientist Assessment", "Need one more model revision."],
      roleBPreview: ["# Modeller Design Report", "Revised the analytic transport closure."],
    },
    1,
  );

  assert.equal(model.activeRole, "modeller");
  assert.equal(model.timeline.length, 3);
  assert.equal(model.feed.length, 2);
  assert.match(model.feed[0]?.detail ?? "", /acceptance bar/);
  assert.equal(model.roleA.artifactName, "scientist-assessment.md");
  assert.equal(model.roleB.artifactName, "modeller-design-report.md");
});
