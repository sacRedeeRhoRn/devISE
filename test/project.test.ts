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
  saveRuntimeState,
  sanitizeId,
} from "../src/lib/project.js";
import {
  legacyRuntimeStatePath,
  projectConfigPath,
  projectStateDir,
  runtimeStatePath,
  specPath,
} from "../src/lib/paths.js";
import { managedThreadName } from "../src/lib/controller.js";

test("sanitizeId normalizes project ids", () => {
  assert.equal(sanitizeId("My Fancy Project!!"), "my-fancy-project");
  assert.equal(makeProjectId("/tmp/Hello World"), "hello-world");
  assert.equal(defaultBranchName("hello-world"), "devise/hello-world/developer");
  assert.equal(managedThreadName("hello-world", "debugger"), "devISE:hello-world:debugger");
});

test("createProjectFiles writes spec, config, and runtime", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "devise-project-"));
  const input = {
    projectRoot,
    goal: "Ship a looped role workflow",
    acceptance: ["Dry tests pass", "Real use passes"],
    dryTestCommands: ["npm test"],
    restartCommands: ["docker compose restart app"],
    useCommands: ["npm run dev"],
    monitorCommands: ["tail -n 50 logs/app.log"],
    monitorUntil: ["ERROR", "panic", "server exited"],
    monitorTimeoutSeconds: 120,
    setupCommands: ["npm install"],
    controllerThreadId: "thread-123",
  };

  const { project, runtime } = await createProjectFiles(input);
  assert.equal(project.project.root, projectRoot);
  assert.equal(runtime.controllerThreadId, "thread-123");

  const spec = await fs.readFile(specPath(projectRoot), "utf8");
  assert.match(spec, /Ship a looped role workflow/);
  assert.match(spec, /docker compose restart app/);
  assert.match(spec, /tail -n 50 logs\/app\.log/);
  assert.match(spec, /ERROR/);
  assert.match(spec, /120/);

  const loadedProject = await loadProjectConfig(projectRoot);
  assert.deepEqual(loadedProject.acceptance, ["Dry tests pass", "Real use passes"]);
  assert.deepEqual(loadedProject.commands.restart, ["docker compose restart app"]);
  assert.deepEqual(loadedProject.commands.monitor, ["tail -n 50 logs/app.log"]);
  assert.deepEqual(loadedProject.commands.monitor_until, ["ERROR", "panic", "server exited"]);
  assert.equal(loadedProject.commands.monitor_timeout_seconds, 120);

  const loadedRuntime = await loadRuntimeState(projectRoot);
  assert.equal(loadedRuntime.projectId, project.project.id);
  assert.deepEqual(loadedRuntime.launch, {});
  assert.equal(loadedRuntime.loop.status, "idle");

  assert.equal(await exists(projectConfigPath(projectRoot)), true);
  assert.equal(await exists(runtimeStatePath(projectRoot)), true);
});

async function exists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

test("loadRuntimeState falls back to legacy .codex-role state and saves in place", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "devise-legacy-project-"));
  const input = {
    projectRoot,
    goal: "Resume an old managed project",
    acceptance: ["Still loads"],
    dryTestCommands: ["npm test"],
    useCommands: ["npm start"],
  };

  await createProjectFiles(input);
  await fs.rename(projectStateDir(projectRoot), path.join(projectRoot, ".codex-role"));

  const loadedProject = await loadProjectConfig(projectRoot);
  assert.equal(loadedProject.goal, "Resume an old managed project");

  const runtime = await loadRuntimeState(projectRoot);
  runtime.loop.iteration = 7;
  await saveRuntimeState(runtime);

  const legacyRuntime = JSON.parse(
    await fs.readFile(legacyRuntimeStatePath(projectRoot), "utf8"),
  ) as { loop: { iteration: number } };
  assert.equal(legacyRuntime.loop.iteration, 7);
  assert.equal(await exists(runtimeStatePath(projectRoot)), false);
});
