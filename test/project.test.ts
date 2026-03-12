import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  createProjectFiles,
  defaultBranchName,
  loadProjectConfig,
  loadRuntimeState,
  makeProjectId,
  sanitizeId,
} from "../src/lib/project.js";
import { projectConfigPath, runtimeStatePath, specPath } from "../src/lib/paths.js";
import { managedThreadName } from "../src/lib/controller.js";

test("sanitizeId and managed naming normalize project ids", () => {
  assert.equal(sanitizeId("My Fancy Project!!"), "my-fancy-project");
  assert.equal(makeProjectId("/tmp/Hello World"), "hello-world");
  assert.equal(defaultBranchName("hello-world"), "devise/hello-world/developer");
  assert.equal(
    defaultBranchName("hello-world", "scientist-modeller"),
    "devise/hello-world/modeller",
  );
  assert.equal(managedThreadName("hello-world", "debugger"), "devISE:hello-world:debugger");
  assert.equal(managedThreadName("hello-world", "scientist"), "devISE:hello-world:scientist");
});

test("createProjectFiles writes a developer-debugger schema-v3 project with charter and persona", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "devise-project-dev-"));
  const { project, runtime } = await createProjectFiles({
    projectRoot,
    loopKind: "developer-debugger",
    goal: "Ship a looped role workflow",
    acceptance: ["Dry tests pass", "Real use passes"],
    dryTestCommands: ["npm test"],
    restartCommands: ["docker compose restart app"],
    useCommands: ["npm run dev"],
    monitorCommands: ["tail -n 50 logs/app.log"],
    monitorUntil: ["ERROR", "panic", "server exited"],
    monitorTimeoutSeconds: 120,
    setupCommands: ["npm install"],
    developerSpecialization: "TypeScript backend and CLI delivery",
    controllerThreadId: "thread-123",
  });

  assert.equal(project.version, 3);
  assert.equal(project.loop_kind, "developer-debugger");
  assert.equal(project.project.root, projectRoot);
  assert.equal(runtime.version, 3);
  assert.equal(runtime.controllerThreadId, "thread-123");
  assert.equal(project.kind, "managed_project");
  assert.ok(project.charter);
  assert.equal(project.charter?.domain, "Software Systems");
  assert.equal(project.loop.max_iterations, null);
  assert.equal(project.loop.stagnation_limit, null);
  assert.match(project.roles.developer?.persona?.title ?? "", /Principal Delivery Engineer/);
  assert.ok((project.roles.developer?.persona?.exemplars.length ?? 0) >= 1);

  const spec = await fs.readFile(specPath(projectRoot), "utf8");
  assert.match(spec, /developer-debugger/);
  assert.match(spec, /docker compose restart app/);
  assert.match(spec, /tail -n 50 logs\/app\.log/);
  assert.match(spec, /Principal Delivery Engineer/);

  const loadedProject = await loadProjectConfig(projectRoot);
  assert.equal(loadedProject.loop_kind, "developer-debugger");
  assert.deepEqual(loadedProject.commands.restart, ["docker compose restart app"]);
  assert.equal(
    loadedProject.roles.developer?.specialization,
    "TypeScript backend and CLI delivery",
  );
  assert.ok(loadedProject.roles.developer?.persona);

  const loadedRuntime = await loadRuntimeState(projectRoot);
  assert.equal(loadedRuntime.projectId, project.project.id);
  assert.equal(loadedRuntime.version, 3);
  assert.deepEqual(loadedRuntime.launch, {});
  assert.equal(loadedRuntime.loop.status, "idle");

  const gitignore = await fs.readFile(path.join(projectRoot, ".gitignore"), "utf8");
  assert.match(gitignore, /\.devise\/watch-events\.jsonl/);

  await assert.doesNotReject(() => fs.access(projectConfigPath(projectRoot)));
  await assert.doesNotReject(() => fs.access(runtimeStatePath(projectRoot)));
});

test("createProjectFiles writes a scientist-modeller schema-v3 project", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "devise-project-sci-"));
  const { project } = await createProjectFiles({
    projectRoot,
    loopKind: "scientist-modeller",
    goal: "Research and refine an analytic transport model",
    acceptance: ["Scientist accepts the model"],
    scientistResearchCommands: ["python research_notes.py"],
    modellerDesignCommands: ["python build_model.py"],
    scientistAssessCommands: ["python assess_model.py"],
    setupCommands: ["uv sync"],
    scientistSpecialization: "Quantum transport theory",
    modellerSpecialization: "Analytic Green's function models",
  });

  assert.equal(project.version, 3);
  assert.equal(project.loop_kind, "scientist-modeller");
  assert.equal(project.git.role_branch, "devise/project/modeller".replace("project", project.project.id));
  assert.equal(project.charter?.domain, "Quantum Transport");
  assert.equal(project.loop.max_iterations, null);
  assert.equal(project.loop.stagnation_limit, null);
  assert.match(project.roles.scientist?.persona?.exemplars.join(", ") ?? "", /Landauer|Anderson|Datta/);

  const spec = await fs.readFile(specPath(projectRoot), "utf8");
  assert.match(spec, /scientist-modeller/);
  assert.match(spec, /python research_notes\.py/);
  assert.match(spec, /Principal Research Scientist/);

  const loadedProject = await loadProjectConfig(projectRoot);
  assert.deepEqual(loadedProject.commands.scientist_research, ["python research_notes.py"]);
  assert.deepEqual(loadedProject.commands.modeller_design, ["python build_model.py"]);
  assert.deepEqual(loadedProject.commands.scientist_assess, ["python assess_model.py"]);
});

test("loadProjectConfig rejects old schema versions clearly", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "devise-project-old-"));
  await fs.mkdir(path.join(projectRoot, ".devise"), { recursive: true });
  await fs.writeFile(
    path.join(projectRoot, ".devise", "project.yaml"),
    [
      "version: 1",
      "project:",
      "  id: old",
      `  root: ${projectRoot}`,
      "goal: old project",
      "acceptance:",
      "  - old",
      "commands:",
      "  dry_test:",
      "    - npm test",
      "  use:",
      "    - npm start",
    ].join("\n"),
    "utf8",
  );

  await assert.rejects(
    () => loadProjectConfig(projectRoot),
    /Unsupported project config version/,
  );
});
