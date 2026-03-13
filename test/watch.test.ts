import test from "node:test";
import assert from "node:assert/strict";

import { buildWatchModel, parseControllerLogFallback, parseWatchEventsText } from "../src/lib/watch.js";
import type { ProjectConfig, RuntimeState, WatchEventRecord } from "../src/lib/types.js";

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
  const project: ProjectConfig = {
    version: 3,
    kind: "managed_project",
    project: {
      id: "demo",
      root: "/tmp/demo",
    },
    loop_kind: "scientist-modeller",
    goal: "Refine the analytic transport model",
    domain: "Quantum Transport",
    summary: "A quantum transport modelling program with a scientist-led acceptance gate.",
    charter: {
      title: "Refine the analytic transport model",
      domain: "Quantum Transport",
      objective: "Refine the analytic transport model",
      acceptance: ["Scientist accepts the model"],
      evidence_bar: "Acceptance requires explicit parity and runtime evidence.",
      constraints: ["Track model assumptions."],
      continuity_summary: "Scientist drives acceptance and modeller iterates until the evidence bar is met.",
    },
    acceptance: ["Scientist accepts the model"],
    commands: {
      scientist_research: ["python research.py"],
      modeller_design: ["python model.py"],
      scientist_assess: ["python assess.py"],
    },
    git: {
      role_branch: "devise/demo/modeller",
      commit_message_template: "role(demo): modeller iteration {{iteration}}",
    },
    loop: {
      max_iterations: 10,
      stagnation_limit: 2,
    },
    roles: {
      scientist: {
        description: "Assess model fitness.",
        persona: {
          title: "Principal Research Scientist for Quantum Transport",
          domain: "Quantum Transport",
          exemplars: ["Rolf Landauer", "Philip W. Anderson", "Sujit Datta"],
          methods: ["test physical regime assumptions"],
          standards: ["Demand explicit evidence"],
          voice_brief: "Skeptical and evidence-driven.",
          hidden_instructions: "Operate as the scientist gate.",
        },
      },
      modeller: {
        description: "Design the model.",
        persona: {
          title: "Principal Analytical Modeller for Quantum Transport",
          domain: "Quantum Transport",
          exemplars: ["Markus Buttiker", "David Thouless", "Rolf Landauer"],
          methods: ["encode transport equations explicitly"],
          standards: ["State assumptions plainly"],
          voice_brief: "Structured and mathematically careful.",
          hidden_instructions: "Operate as the modeller.",
        },
      },
    },
  };

  const runtime: RuntimeState = {
    version: 3,
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
      project,
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
          kind: "reasoning_snapshot",
          role: "scientist",
          iteration: 3,
          message: "Scientist reasoning: re-check the assessment gate | one acceptance gap remains | next: inspect the revised closure",
          reasoning: {
            intent: "re-check the assessment gate",
            current_step: "inspect the revised closure",
            finding_or_risk: "one acceptance gap remains",
            next_action: "re-run the parity check",
          },
        },
        {
          version: 1,
          at: "2026-03-13T02:07:00.000Z",
          kind: "reasoning_snapshot",
          role: "scientist",
          iteration: 3,
          message: "Scientist reasoning: verify closure residuals | residual drift remains | next: inspect the new closure trace",
          reasoning: {
            intent: "verify closure residuals",
            current_step: "inspect the new closure trace",
            finding_or_risk: "residual drift remains",
            next_action: "compare the new closure trace with the accepted baseline",
          },
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
  assert.equal(model.projectDomain, "Quantum Transport");
  assert.equal(model.timeline.length, 3);
  assert.equal(model.feed.length, 3);
  assert.match(model.feed[0]?.detail ?? "", /Reasoning snapshot/i);
  assert.equal(model.roleA.artifactName, "scientist-assessment.md");
  assert.equal(model.roleB.artifactName, "modeller-design-report.md");
  assert.match(model.roleA.personaSummary, /Landauer|Anderson|Datta/);
  assert.match(model.roleA.latestReasoning ?? "", /inspect the new closure trace/);
  assert.equal(model.roleA.reasoningTrail.length, 2);
  assert.match(model.roleA.detail, /inspect the revised closure/);
  assert.match(model.roleA.detail, /inspect the new closure trace/);
});

test("buildWatchModel keeps full feed history instead of truncating older reasoning snapshots", () => {
  const baseProject: ProjectConfig = {
    version: 3,
    kind: "managed_project",
    project: {
      id: "demo",
      root: "/tmp/demo",
    },
    loop_kind: "developer-debugger",
    goal: "Stabilize the patch loop",
    acceptance: ["Debugger accepts the result"],
    commands: {
      dry_test: ["npm test"],
      use: ["npm run serve"],
    },
    git: {
      role_branch: "devise/demo/developer",
      commit_message_template: "role(demo): developer iteration {{iteration}}",
    },
    loop: {
      max_iterations: null,
      stagnation_limit: null,
    },
    roles: {
      developer: {
        description: "Patch code.",
      },
      debugger: {
        description: "Verify runtime behavior.",
      },
    },
  };

  const baseRuntime: RuntimeState = {
    version: 3,
    projectId: "demo",
    projectRoot: "/tmp/demo",
    roles: {},
    launch: {},
    loop: {
      status: "running",
      iteration: 41,
      task: "Stabilize the patch loop",
      startRole: "developer",
      lastRole: "developer",
    },
    history: [],
  };

  const events: WatchEventRecord[] = Array.from({ length: 95 }, (_, index) => ({
    version: 1,
    at: `2026-03-13T02:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`,
    kind: "reasoning_snapshot",
    role: "developer",
    iteration: index + 1,
    message: `Developer reasoning snapshot ${index + 1}`,
    reasoning: {
      intent: `intent ${index + 1}`,
      current_step: `step ${index + 1}`,
      finding_or_risk: `risk ${index + 1}`,
      next_action: `next ${index + 1}`,
    },
  }));

  const model = buildWatchModel(
    {
      projectId: "demo",
      projectRoot: "/tmp/demo",
      project: baseProject,
      runtime: baseRuntime,
      roleA: "developer",
      roleB: "debugger",
      controllerAlive: true,
      events,
      roleAPreview: [],
      roleBPreview: [],
    },
    0,
  );

  assert.equal(model.feed.length, 95);
  assert.equal(model.roleA.reasoningTrail.length, 95);
  assert.match(model.roleA.detail, /step 1/);
  assert.match(model.roleA.detail, /step 95/);
});
