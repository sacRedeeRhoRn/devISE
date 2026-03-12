#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import path from "node:path";

import { RoleService } from "./lib/service.js";
import { repoRootFromModule } from "./lib/paths.js";
import { startWatch } from "./lib/watch.js";
import { startMcpServer } from "./mcp/server.js";

async function main(): Promise<void> {
  const repoRoot = repoRootFromModule(import.meta.url);
  const cliEntrypoint = fileURLToPath(import.meta.url);
  const service = new RoleService(repoRoot, cliEntrypoint);
  const [command, ...rest] = process.argv.slice(2);

  switch (command) {
    case "install": {
      const result = await service.install();
      console.log(`Prompt: ${result.promptPath}`);
      console.log(`Skill: ${result.skillPath}`);
      console.log(`Config: ${result.configPath}`);
      return;
    }

    case "doctor": {
      const projectRoot = rest[0];
      const findings = await service.doctor(projectRoot);
      for (const line of findings) {
        console.log(line);
      }
      return;
    }

    case "status": {
      const projectRoot = rest[0] ?? process.cwd();
      const status = await service.getStatus(projectRoot);
      const armed = Boolean(
        status.runtime.launch.stagedStartRole && status.runtime.launch.stagedTask,
      );
      console.log(`project: ${status.project.project.id}`);
      console.log(`root: ${status.project.project.root}`);
      console.log(`loop: ${status.runtime.loop.status}`);
      console.log(`iteration: ${status.runtime.loop.iteration}`);
      console.log(`armed: ${armed}`);
      console.log(`loop_task: ${status.runtime.loop.task ?? "none"}`);
      console.log(`staged_start_role: ${status.runtime.launch.stagedStartRole ?? "none"}`);
      console.log(`staged_task: ${status.runtime.launch.stagedTask ?? "none"}`);
      console.log(`pid: ${status.runtime.loop.pid ?? "none"}`);
      console.log(`controller_alive: ${status.controllerAlive}`);
      console.log(`roles: ${Object.keys(status.runtime.roles).join(", ") || "none"}`);
      if (status.runtime.roles.developer) {
        console.log(`developer_thread: ${status.runtime.roles.developer.threadId}`);
      }
      if (status.runtime.roles.debugger) {
        console.log(`debugger_thread: ${status.runtime.roles.debugger.threadId}`);
      }
      if (status.runtime.loop.lastReportPath) {
        console.log(`last_report: ${status.runtime.loop.lastReportPath}`);
      }
      if (status.runtime.loop.lastCommitSha) {
        console.log(`last_commit: ${status.runtime.loop.lastCommitSha}`);
      }
      if (status.runtime.loop.lastError) {
        console.log(`last_error: ${status.runtime.loop.lastError}`);
      }
      return;
    }

    case "stage-launch": {
      const projectRoot = valueForFlag(rest, "--project-root");
      const startRole = valueForFlag(rest, "--start-role");
      const task = valueForFlag(rest, "--task");
      if (!projectRoot || !task || (startRole !== "developer" && startRole !== "debugger")) {
        throw new Error(`stage-launch requires --project-root, --start-role, and --task`);
      }
      const runtime = await service.stageLaunch({
        projectRoot: path.resolve(projectRoot),
        startRole,
        task,
      });
      console.log(`project: ${runtime.projectId}`);
      console.log(`staged_start_role: ${runtime.launch.stagedStartRole ?? "none"}`);
      console.log(`staged_task: ${runtime.launch.stagedTask ?? "none"}`);
      return;
    }

    case "flight": {
      const projectRoot = valueForFlag(rest, "--project-root");
      if (!projectRoot) {
        throw new Error(`flight requires --project-root`);
      }
      const runtime = await service.startLoop({
        projectRoot: path.resolve(projectRoot),
      });
      console.log(`project: ${runtime.projectId}`);
      console.log(`loop: ${runtime.loop.status}`);
      console.log(`start_role: ${runtime.loop.startRole ?? "none"}`);
      console.log(`task: ${runtime.loop.task ?? "none"}`);
      console.log(`pid: ${runtime.loop.pid ?? "none"}`);
      return;
    }

    case "land": {
      const projectRoot = valueForFlag(rest, "--project-root");
      if (!projectRoot) {
        throw new Error(`land requires --project-root`);
      }
      const status = await service.getStatus(path.resolve(projectRoot));
      if (status.controllerAlive) {
        await service.stopLoop(status.project.project.root);
      }
      const runtime = await service.clearLaunch(status.project.project.root);
      console.log(`project: ${runtime.projectId}`);
      console.log(`loop: ${runtime.loop.status}`);
      console.log(`staged_start_role: ${runtime.launch.stagedStartRole ?? "none"}`);
      console.log(`staged_task: ${runtime.launch.stagedTask ?? "none"}`);
      return;
    }

    case "watch": {
      const projectRoot = rest[0] ?? process.cwd();
      await startWatch(service, projectRoot);
      return;
    }

    case "serve":
      await startMcpServer(service);
      return;

    case "run-loop": {
      const projectRoot = valueForFlag(rest, "--project-root");
      const startRole = valueForFlag(rest, "--start-role");
      const task = valueForFlag(rest, "--task");
      if (!projectRoot || !task || (startRole !== "developer" && startRole !== "debugger")) {
        throw new Error(`run-loop requires --project-root, --start-role, and --task`);
      }
      await service.runLoopForeground({
        projectRoot: path.resolve(projectRoot),
        startRole,
        task,
      });
      return;
    }

    default:
      printUsage();
  }
}

function valueForFlag(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) {
    return undefined;
  }
  return args[index + 1];
}

function printUsage(): never {
  console.error(`Usage:
  devISE install
  devISE doctor [project-root]
  devISE status [project-root]
  devISE stage-launch --project-root <path> --start-role <developer|debugger> --task <text>
  devISE flight --project-root <path>
  devISE land --project-root <path>
  devISE watch [project-root|project-id]
  devISE serve
  devISE run-loop --project-root <path> --start-role <developer|debugger> --task <text>`);
  process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
