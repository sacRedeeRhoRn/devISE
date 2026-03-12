# devISE

`devISE` installs a Codex custom prompt, a planning skill, and an MCP server that can manage long-running role loops against Codex threads.

## Install

```bash
npm install
npm run build
node dist/src/cli.js install
node dist/src/cli.js doctor
```

`install` updates your Codex setup with:

- `/role` prompt entrypoint
- `/devise` prompt alias
- `/devise-flight` launch prompt
- `/devise-land` landing prompt
- `devISE watch` terminal monitor
- `role.*` MCP tools for compatibility
- `devise.*` MCP tools as the current namespace
- `role-project-planner` and `devise-project-planner` skill installs

Re-run `node dist/src/cli.js install` after pulling updates so the installed prompt, skills, and MCP config stay in sync.

## In Codex

After install, open Codex in the project you want to manage and use one of these:

```text
/role create-project
/role
/role resume-project
/devise-flight
/devise-land
```

Behavior:

- `/role create-project` creates the managed project spec, charter, generated role personas, and command contract.
- `/role` can also create a non-runnable portfolio container through `devise.create_portfolio` when you want a head project that groups child projects.
- `/role` defaults to resume for the current working directory.
- `/role` checks current status first, reuses any existing active-role assignments, attaches any missing session for the project loop kind, visibly primes each assigned session with its expert identity, and stages the next launch seed.
- `/devise-flight` is the only prompt that starts the automatic loop from the staged start role and task.
- `/devise-land` stops the running loop if needed and clears the staged launch while keeping role assignments.
- Once `/devise-flight` starts the loop, the controller alternates the active pair automatically until the project goal is met, blocked, failed, or manually landed.
- `devISE watch <project>` opens the editorial PTY monitor with the role timeline, live observable activity feed, latest handoffs, and controller state.

`/devise` is kept as an alias, but `/role` should be treated as the primary entrypoint.

## Project Contract

Each new managed project stores schema v3 metadata under `.devise/`:

- a fixed `loopKind`
- a generated project charter
- generated world-class role personas for the active pair
- a loop-specific command contract
- an optional portfolio parent recorded in the registry

`developer-debugger` projects use:

- `commands.setup`
- `commands.dry_test`
- `commands.restart`
- `commands.use`
- `commands.monitor`
- `commands.monitor_until`
- `commands.monitor_timeout_seconds`

`scientist-modeller` projects use:

- `commands.setup`
- `commands.scientist_research`
- `commands.modeller_design`
- `commands.scientist_assess`

## CLI

- `npm run build`
- `npm test`
- `node dist/src/cli.js install`
- `node dist/src/cli.js doctor`
- `node dist/src/cli.js portfolio-create --title <title> --goal <goal> [--id <id>] [--domain <domain>] [--summary <text>]`
- `node dist/src/cli.js move-project --project <project-id|project-root> [--parent <portfolio-id|none>]`
- `node dist/src/cli.js status <project-id>`
- `node dist/src/cli.js stage-launch --project-root <path> --start-role <developer|debugger|scientist|modeller> --task <text>`
- `node dist/src/cli.js flight --project-root <path>`
- `node dist/src/cli.js land --project-root <path>`
- `node dist/src/cli.js watch [project-id|project-root]`
- `node dist/src/cli.js serve`
- `node dist/src/cli.js run-loop --project-root <path> --start-role <developer|debugger|scientist|modeller> --task <text>` (internal controller entrypoint)

## Notes

- New managed projects use schema version 3 with generated charter and persona data. Older v2 managed projects remain usable on their legacy path and are not auto-upgraded.
- Portfolio containers are registry-only organizational entries. They are non-runnable and only provide defaults that are copied into a child project at creation time.
- `status` accepts either a project root or a registered project id.
- The watcher shows observable progress only: role commentary, command activity, handoff/report excerpts, commits, and loop events. It does not expose hidden chain-of-thought.
- Landing keeps role assignments but clears the staged launch, so the next automatic run must be re-armed from `/role`.
- Managed active-role threads now run with full host and network access. They can execute arbitrary local commands and remote operations such as SSH, qsub, package installs, and web retrieval when the task requires it.
