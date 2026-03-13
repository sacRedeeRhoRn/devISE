import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  connectivityIssueFromTextsForTest,
  isMissingRolloutErrorForTest,
  observableTurnEventsForTest,
  recoverInvalidTurnResultForTest,
  roleOutputSchemasForTest,
  shouldKeepCurrentRoleForTest,
  validateDebuggerTurnResultForTest,
} from "../src/lib/controller.js";
import type { ProjectConfig } from "../src/lib/types.js";

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
  assert.equal(debuggerProperties.restart_result?.type, "string");
  assert.equal(debuggerProperties.monitor_result?.type, "string");
  assert.equal(debuggerProperties.evidence_sufficient?.type, "boolean");
  assert.equal(debuggerProperties.monitoring_evidence?.type, "string");
  assert.equal(debuggerProperties.enhancement_targets?.type, "array");
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

test("invalid final replies are recovered into blocked results with saved artifacts", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "devise-controller-"));
  const artifactPath = path.join(tempDir, "iter-001", "developer-handoff.md");
  const project = makeProjectConfig();

  try {
    const result = await recoverInvalidTurnResultForTest(
      project,
      "developer",
      "**Status** still investigating the current benchmark path.",
      artifactPath,
      new Error("Role output is not valid JSON: **Status** still investigating the current benchmark path."),
    );

    assert.equal(result.status, "blocked");
    assert.equal(result.dry_test_passed, false);
    assert.equal(result.handoff_report_path, artifactPath);
    assert.match(result.blocking_reason ?? "", /Role output is not valid JSON/);

    const artifact = await fs.readFile(artifactPath, "utf8");
    assert.match(artifact, /Developer Invalid Final Reply/);
    assert.match(artifact, /Raw final reply:/);
    assert.match(artifact, /\*\*Status\*\* still investigating/);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("debugger validation rejects shallow needs_fix results without monitoring evidence or targets", () => {
  const project = makeProjectConfig({
    commands: {
      setup: [],
      dry_test: ["npm test"],
      restart: ["./restart.sh"],
      use: ["./run-real.sh"],
      monitor: ["tail -f progress.log"],
      monitor_until: ["worker_done"],
      monitor_timeout_seconds: 300,
    },
  });

  assert.throws(
    () =>
      validateDebuggerTurnResultForTest(project, {
        status: "needs_fix",
        use_passed: false,
        summary: "Collected only a short snapshot before writing the report.",
        report_path: "/tmp/debugger-report.md",
        restart_performed: true,
        restart_result: "performed",
        monitor_result: "process_ended",
        evidence_sufficient: false,
        monitoring_evidence: "",
        issues: ["The run still looks unstable."],
        enhancement_targets: [],
      }),
    /enough monitoring evidence|monitoring_evidence|enhancement_targets/,
  );
});

test("debugger validation accepts evidence-rich needs_fix results", () => {
  const project = makeProjectConfig({
    commands: {
      setup: [],
      dry_test: ["npm test"],
      restart: ["./restart.sh"],
      use: ["./run-real.sh"],
      monitor: ["tail -f progress.log"],
      monitor_until: ["worker_done"],
      monitor_timeout_seconds: 300,
    },
  });

  assert.doesNotThrow(() =>
    validateDebuggerTurnResultForTest(project, {
      status: "needs_fix",
      use_passed: false,
      summary: "Monitoring established a repeatable frontier stall and clear next targets.",
      report_path: "/tmp/debugger-report.md",
      restart_performed: true,
      restart_result: "performed",
      monitor_result: "caveat_observed",
      evidence_sufficient: true,
      monitoring_evidence:
        "Observed 22 minutes of queue and progress output, repeated frontier stalls at d07_e0p1, and no benchmark_summary.json emission before the worker exited.",
      observed_caveat: "frontier stalled at d07_e0p1",
      issues: [
        "The real benchmark still stalls before producing benchmark_summary.json.",
      ],
      enhancement_targets: [
        "Inspect the frontier aggregation path around d07_e0p1.",
        "Add explicit logging when benchmark_summary.json is skipped.",
      ],
    }),
  );
});

test("debugger validation accepts restart commands that report an already running workflow", () => {
  const project = makeProjectConfig({
    commands: {
      setup: [],
      dry_test: ["npm test"],
      restart: ["./restart.sh"],
      use: ["./run-real.sh"],
      monitor: ["tail -f progress.log"],
      monitor_until: ["worker_done"],
      monitor_timeout_seconds: 300,
    },
  });

  assert.doesNotThrow(() =>
    validateDebuggerTurnResultForTest(project, {
      status: "needs_fix",
      use_passed: false,
      summary: "Run stayed active, so the restart command reported already running and monitoring continued.",
      report_path: "/tmp/debugger-report.md",
      restart_performed: false,
      restart_result: "already_running",
      monitor_result: "caveat_observed",
      evidence_sufficient: true,
      monitoring_evidence:
        "Restart command returned already_running, status/diagnose stayed healthy, and extended monitoring reproduced the warm-start caveat.",
      observed_caveat: "true continuation warm-start is still not happening",
      issues: [
        "Weights reload, but optimizer, scheduler, epoch, and seeds still reset between iterations.",
      ],
      enhancement_targets: [
        "Preserve optimizer, scheduler, and epoch state when using previous-member checkpoints.",
        "Persist stable per-member seeds across iterations.",
      ],
    }),
  );
});

test("debugger validation accepts restart commands that fail but still yield actionable evidence", () => {
  const project = makeProjectConfig({
    commands: {
      setup: [],
      dry_test: ["npm test"],
      restart: ["./restart.sh"],
      use: ["./run-real.sh"],
      monitor: ["tail -f progress.log"],
      monitor_until: ["worker_done"],
      monitor_timeout_seconds: 300,
    },
  });

  assert.doesNotThrow(() =>
    validateDebuggerTurnResultForTest(project, {
      status: "needs_fix",
      use_passed: true,
      summary: "The clean restart path failed, but the live use flow still ran and exposed an early benchmark-failure caveat.",
      report_path: "/tmp/debugger-report.md",
      restart_performed: false,
      restart_result: "failed",
      monitor_result: "caveat_observed",
      evidence_sufficient: true,
      monitoring_evidence:
        "The restart command failed during remote bootstrap, but the benchmark still launched and produced enough overlap evidence to prove the current run is out of tolerance.",
      observed_caveat: "benchmark overlap already proves failure while the managed benchmark path keeps running",
      issues: [
        "The configured clean restart path still fails during remote bootstrap.",
        "The live benchmark does not terminate promptly after sufficient failed-overlap evidence appears.",
      ],
      enhancement_targets: [
        "Fix the remote bootstrap path used by the restart contract.",
        "Emit partial comparison and final summary artifacts immediately when failed overlap is already sufficient.",
      ],
    }),
  );
});

test("debugger validation accepts continue_monitoring while a live run is still progressing", () => {
  const project = makeProjectConfig({
    commands: {
      setup: [],
      dry_test: ["npm test"],
      restart: ["./restart.sh"],
      use: ["./run-real.sh"],
      monitor: ["tail -f progress.log"],
      monitor_until: ["worker_done"],
      monitor_timeout_seconds: 300,
    },
  });

  assert.doesNotThrow(() =>
    validateDebuggerTurnResultForTest(project, {
      status: "continue_monitoring",
      use_passed: true,
      summary: "The GPU md run is still active and progressing, so the debugger should keep monitoring until AL phases begin.",
      report_path: "/tmp/debugger-report.md",
      restart_performed: false,
      restart_result: "already_running",
      monitor_result: "still_running",
      evidence_sufficient: false,
      monitoring_evidence:
        "Confirmed active GPU md process, growing remote outputs, and healthy status/diagnose, but the run has not yet reached AL selection or continuation phases.",
      observed_caveat: "GPU memory headroom is extremely tight while detached md is still progressing",
      issues: [
        "Detached md observability is weak while the run is still in progress.",
        "GPU memory headroom is extremely tight during the current md phase.",
      ],
      enhancement_targets: [
        "Expose md branch completion counts in status/diagnose.",
        "Escalate GPU memory pressure before the run reaches failure territory.",
      ],
    }),
  );
});

test("debugger validation rejects continue_monitoring with terminal block semantics", () => {
  const project = makeProjectConfig({
    commands: {
      setup: [],
      dry_test: ["npm test"],
      restart: ["./restart.sh"],
      use: ["./run-real.sh"],
      monitor: ["tail -f progress.log"],
      monitor_until: ["worker_done"],
      monitor_timeout_seconds: 300,
    },
  });

  assert.throws(
    () =>
      validateDebuggerTurnResultForTest(project, {
        status: "continue_monitoring",
        use_passed: true,
        summary: "The run is still live.",
        report_path: "/tmp/debugger-report.md",
        restart_performed: false,
        restart_result: "already_running",
        monitor_result: "process_ended",
        evidence_sufficient: true,
        monitoring_evidence: "Only partial evidence so far.",
        issues: [],
        enhancement_targets: [],
        blocking_reason: "Should not be terminal",
      }),
    /still_running|evidence_sufficient=false|blocking_reason/,
  );
});

test("debugger validation rejects restart_result=failed without concrete issues", () => {
  const project = makeProjectConfig({
    commands: {
      setup: [],
      dry_test: ["npm test"],
      restart: ["./restart.sh"],
      use: ["./run-real.sh"],
      monitor: ["tail -f progress.log"],
      monitor_until: ["worker_done"],
      monitor_timeout_seconds: 300,
    },
  });

  assert.throws(
    () =>
      validateDebuggerTurnResultForTest(project, {
        status: "needs_fix",
        use_passed: true,
        summary: "Restart failed but no concrete issue was recorded.",
        report_path: "/tmp/debugger-report.md",
        restart_performed: false,
        restart_result: "failed",
        monitor_result: "caveat_observed",
        evidence_sufficient: true,
        monitoring_evidence: "Some evidence exists.",
        observed_caveat: "restart path failed",
        issues: [],
        enhancement_targets: ["Fix the restart path"],
      }),
    /restart_result=failed without concrete issues/,
  );
});

test("controller keeps debugger on baton while live monitoring is still in progress", () => {
  const project = makeProjectConfig();

  assert.equal(
    shouldKeepCurrentRoleForTest(project, "debugger", {
      status: "continue_monitoring",
      summary: "Still monitoring",
      use_passed: true,
      restart_performed: false,
      restart_result: "already_running",
      monitor_result: "still_running",
      evidence_sufficient: false,
      monitoring_evidence: "Live run still progressing",
      issues: [],
      enhancement_targets: [],
    }),
    true,
  );

  assert.equal(
    shouldKeepCurrentRoleForTest(project, "debugger", {
      status: "needs_fix",
      summary: "Found a real caveat",
      use_passed: false,
      restart_performed: false,
      restart_result: "already_running",
      monitor_result: "caveat_observed",
      evidence_sufficient: true,
      monitoring_evidence: "Warm-start caveat reproduced",
      observed_caveat: "warm-start still resets optimizer state",
      issues: ["Warm-start semantics are wrong"],
      enhancement_targets: ["Preserve optimizer state"],
    }),
    false,
  );
});

function makeProjectConfig(
  overrides: Partial<ProjectConfig> = {},
): ProjectConfig {
  return {
    version: 3,
    kind: "managed_project",
    project: {
      id: "sample-project",
      root: "/tmp/sample-project",
    },
    loop_kind: "developer-debugger",
    goal: "Stabilize the managed benchmark workflow.",
    acceptance: ["Real benchmark completes cleanly."],
    commands: {
      setup: [],
      dry_test: ["npm test"],
      restart: [],
      use: ["./run-real.sh"],
      monitor: [],
      monitor_until: [],
      monitor_timeout_seconds: 300,
    },
    git: {
      role_branch: "devise/sample-project/developer",
      commit_message_template: "role(sample-project): developer iteration {{iteration}}",
    },
    loop: {
      max_iterations: null,
      stagnation_limit: null,
    },
    roles: {
      developer: {
        description: "Patches code until dry tests pass.",
      },
      debugger: {
        description: "Runs the real workflow and validates the result.",
      },
    },
    ...overrides,
  };
}
