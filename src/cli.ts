#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import path from "node:path";

import { RoleService } from "./lib/service.js";
import { repoRootFromModule } from "./lib/paths.js";
import { activeRolesForLoopKind, ROLE_KINDS } from "./lib/types.js";
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
      console.log(`title: ${status.project.charter?.title ?? status.project.goal}`);
      console.log(`domain: ${status.project.charter?.domain ?? status.project.domain ?? "unknown"}`);
      console.log(`project_kind: ${status.registryEntry?.kind ?? "managed_project"}`);
      console.log(`parent_id: ${status.registryEntry?.kind === "managed_project" ? status.registryEntry.parentId ?? "none" : "none"}`);
      console.log(`loop_kind: ${status.project.loop_kind}`);
      console.log(`active_roles: ${activeRolesForLoopKind(status.project.loop_kind).join(", ")}`);
      console.log(`loop: ${status.runtime.loop.status}`);
      console.log(`iteration: ${status.runtime.loop.iteration}`);
      console.log(`armed: ${armed}`);
      console.log(`loop_task: ${status.runtime.loop.task ?? "none"}`);
      console.log(`staged_start_role: ${status.runtime.launch.stagedStartRole ?? "none"}`);
      console.log(`staged_task: ${status.runtime.launch.stagedTask ?? "none"}`);
      console.log(`pid: ${status.runtime.loop.pid ?? "none"}`);
      console.log(`controller_alive: ${status.controllerAlive}`);
      console.log(`roles: ${Object.keys(status.runtime.roles).join(", ") || "none"}`);
      for (const role of activeRolesForLoopKind(status.project.loop_kind)) {
        if (status.runtime.roles[role]) {
          console.log(`${role}_thread: ${status.runtime.roles[role]?.threadId}`);
        }
        const persona = status.project.roles[role]?.persona;
        if (persona) {
          console.log(`${role}_persona: ${persona.title}`);
          console.log(`${role}_exemplars: ${persona.exemplars.join(", ")}`);
        }
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

    case "portfolio-create": {
      const title = valueForFlag(rest, "--title");
      const goal = valueForFlag(rest, "--goal");
      if (!title || !goal) {
        throw new Error(`portfolio-create requires --title and --goal`);
      }
      const entry = await service.createPortfolio({
        portfolioId: valueForFlag(rest, "--id"),
        title,
        goal,
        domain: valueForFlag(rest, "--domain"),
        summary: valueForFlag(rest, "--summary"),
        developerPersonaHint: valueForFlag(rest, "--developer-hint"),
        debuggerPersonaHint: valueForFlag(rest, "--debugger-hint"),
        scientistPersonaHint: valueForFlag(rest, "--scientist-hint"),
        modellerPersonaHint: valueForFlag(rest, "--modeller-hint"),
      });
      console.log(`portfolio: ${entry.id}`);
      console.log(`title: ${entry.title}`);
      console.log(`domain: ${entry.domain ?? "none"}`);
      return;
    }

    case "move-project": {
      const projectSelector = valueForFlag(rest, "--project");
      if (!projectSelector) {
        throw new Error(`move-project requires --project`);
      }
      const parent = valueForFlag(rest, "--parent");
      const moved = await service.moveProject({
        projectSelector,
        newHeadProjectId: !parent || parent === "none" ? null : parent,
      });
      console.log(`project: ${moved.id}`);
      console.log(`parent_id: ${moved.parentId ?? "none"}`);
      return;
    }

    case "stage-launch": {
      const projectRoot = valueForFlag(rest, "--project-root");
      const startRole = valueForFlag(rest, "--start-role");
      const task = valueForFlag(rest, "--task");
      if (!projectRoot || !task || !isKnownRole(startRole)) {
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
      if (!projectRoot || !task || !isKnownRole(startRole)) {
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
  devISE portfolio-create --title <title> --goal <goal> [--id <id>] [--domain <domain>] [--summary <text>] [--developer-hint <text>] [--debugger-hint <text>] [--scientist-hint <text>] [--modeller-hint <text>]
  devISE move-project --project <project-id|project-root> [--parent <portfolio-id|none>]
  devISE stage-launch --project-root <path> --start-role <developer|debugger|scientist|modeller> --task <text>
  devISE flight --project-root <path>
  devISE land --project-root <path>
  devISE watch [project-root|project-id]
  devISE serve
  devISE run-loop --project-root <path> --start-role <developer|debugger|scientist|modeller> --task <text>`);
  process.exit(1);
}

function isKnownRole(value: string | undefined): value is (typeof ROLE_KINDS)[number] {
  return Boolean(value && ROLE_KINDS.includes(value as (typeof ROLE_KINDS)[number]));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
