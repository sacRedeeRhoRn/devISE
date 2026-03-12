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
    useCommands: ["npm run dev"],
    setupCommands: ["npm install"],
    controllerThreadId: "thread-123",
  };

  const { project, runtime } = await createProjectFiles(input);
  assert.equal(project.project.root, projectRoot);
  assert.equal(runtime.controllerThreadId, "thread-123");

  const spec = await fs.readFile(specPath(projectRoot), "utf8");
  assert.match(spec, /Ship a looped role workflow/);

  const loadedProject = await loadProjectConfig(projectRoot);
  assert.deepEqual(loadedProject.acceptance, ["Dry tests pass", "Real use passes"]);

  const loadedRuntime = await loadRuntimeState(projectRoot);
  assert.equal(loadedRuntime.projectId, project.project.id);
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
