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
        role: "debugger",
        message: "Debugger turn started",
      } satisfies WatchEventRecord),
    ].join("\n"),
  );

  assert.equal(events.length, 2);
  assert.equal(events[0]?.kind, "turn_started");
  assert.equal(events[1]?.kind, "turn_completed");
});

test("parseControllerLogFallback produces readable generic events", () => {
  const events = parseControllerLogFallback(
    "2026-03-13T02:10:00.000Z iter=2 role=developer event=turn_completed status=blocked message=\"Developer blocked\"\n",
  );

  assert.equal(events.length, 1);
  assert.equal(events[0]?.kind, "turn_completed");
  assert.equal(events[0]?.role, "developer");
  assert.match(events[0]?.message ?? "", /Developer blocked/);
});

test("buildWatchModel prioritizes live feed, timeline, and role snapshots", () => {
  const runtime: RuntimeState = {
    version: 1,
    projectId: "demo",
    projectRoot: "/tmp/demo",
    roles: {
      developer: {
        role: "developer",
        threadId: "developer-thread",
        threadName: "devISE:demo:developer",
        sourceMode: "current",
        assignedAt: "2026-03-13T02:00:00.000Z",
      },
      debugger: {
        role: "debugger",
        threadId: "debugger-thread",
        threadName: "devISE:demo:debugger",
        sourceMode: "current",
        assignedAt: "2026-03-13T02:00:00.000Z",
      },
    },
    launch: {},
    loop: {
      status: "running",
      iteration: 3,
      task: "Fix the remaining parity gap",
      startRole: "debugger",
      lastRole: "developer",
      lastCommitSha: "abcdef1234567890",
    },
    history: [
      {
        iteration: 1,
        role: "debugger",
        status: "needs_fix",
        summary: "Debugger found the failing preflight path.",
        artifactPath: "/tmp/demo/.devise/artifacts/iter-001/debugger-report.md",
        at: "2026-03-13T02:01:00.000Z",
      },
      {
        iteration: 2,
        role: "developer",
        status: "green",
        summary: "Developer patched the qsub transport-only preflight branch.",
        artifactPath: "/tmp/demo/.devise/artifacts/iter-002/developer-handoff.md",
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
      controllerAlive: true,
      events: [
        {
          version: 1,
          at: "2026-03-13T02:06:00.000Z",
          kind: "command_started",
          role: "debugger",
          iteration: 3,
          message: "Debugger running wtec_rgf_runner",
          command: "wtec_rgf_runner payload.json raw.json",
        },
        {
          version: 1,
          at: "2026-03-13T02:06:30.000Z",
          kind: "commentary",
          role: "debugger",
          iteration: 3,
          message: "Monitoring progress.jsonl for worker_done before handing back.",
        },
      ],
      developerRecord: runtime.history[1],
      debuggerRecord: runtime.history[0],
      developerPreview: ["# Developer Handoff", "Patched qsub preflight behavior."],
      debuggerPreview: ["# Debugger Report", "Observed worker_done and parity within tolerance."],
    },
    1,
  );

  assert.equal(model.activeRole, "developer");
  assert.equal(model.timeline.length, 3);
  assert.equal(model.feed.length, 2);
  assert.match(model.feed[0]?.detail ?? "", /Monitoring progress\.jsonl/);
  assert.equal(model.roles.developer.artifactName, "developer-handoff.md");
  assert.equal(model.roles.debugger.artifactName, "debugger-report.md");
});
