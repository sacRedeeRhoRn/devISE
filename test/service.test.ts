import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { RoleService } from "../src/lib/service.js";
import {
  createProjectFiles,
  loadRuntimeState,
  saveRuntimeState,
} from "../src/lib/project.js";

function makeService(): RoleService {
  return new RoleService(process.cwd(), path.join(process.cwd(), "dist/src/cli.js"));
}

test("startLoop requires both roles to be assigned before launch", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "devise-service-project-"));
  await createProjectFiles({
    projectRoot,
    goal: "Require both roles",
    acceptance: ["roles must be assigned first"],
    dryTestCommands: ["npm test"],
    useCommands: ["npm start"],
  });

  const service = makeService();
  await assert.rejects(
    () =>
      service.startLoop({
        projectRoot,
        startRole: "developer",
        task: "Implement the next requested change",
      }),
    /Both roles must be assigned before starting the loop/,
  );
});

test("getStatus marks dead running controllers as orphaned", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "devise-service-status-"));
  await createProjectFiles({
    projectRoot,
    goal: "Detect orphaned loop state",
    acceptance: ["status should be clear"],
    dryTestCommands: ["npm test"],
    useCommands: ["npm start"],
  });

  const runtime = await loadRuntimeState(projectRoot);
  runtime.loop.status = "running";
  runtime.loop.pid = 99999999;
  runtime.loop.task = "Continue the assigned task";
  await saveRuntimeState(runtime);

  const service = makeService();
  const status = await service.getStatus(projectRoot);

  assert.equal(status.controllerAlive, false);
  assert.equal(status.runtime.loop.status, "orphaned");
  assert.equal(status.runtime.loop.pid, undefined);
  assert.match(status.runtime.loop.lastError ?? "", /no longer alive|without an active pid/);
});
