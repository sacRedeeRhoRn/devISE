# devISE

`devISE` installs a Codex custom prompt, a planning skill, and an MCP server that can manage long-running developer/debugger role loops against Codex threads.

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
```

Behavior:

- `/role create-project` creates the managed project spec and command contract.
- `/role` defaults to resume for the current working directory.
- Resume flow checks current status first, reuses any existing role assignments, and attaches any missing `developer` or `debugger` session.
- After both roles are assigned, you provide:
  the role that should take the next task first
  the exact task that should seed the loop
- The controller starts only after that explicit task seed.
- Each role writes a detailed handoff artifact for the counterpart role, and the controller alternates between them until the project goal is met, blocked, orphaned, or stagnated.

`/devise` is kept as an alias, but `/role` should be treated as the primary entrypoint.

## Project Contract

Each managed project stores a command contract under `.devise/` or legacy `.codex-role/`.

- `commands.setup`: one-time environment bootstrap
- `commands.dry_test`: checks the developer must pass before handoff
- `commands.restart`: clean restart commands the debugger must run before verification
- `commands.use`: real-use commands the debugger must exercise
- `commands.monitor`: commands the debugger uses to keep watching the restarted system
- `commands.monitor_until`: caveats or stop conditions that end monitoring
- `commands.monitor_timeout_seconds`: maximum monitor window before timeout

## CLI

- `npm run build`
- `npm test`
- `node dist/src/cli.js install`
- `node dist/src/cli.js doctor`
- `node dist/src/cli.js status <project-id>`
- `node dist/src/cli.js serve`
- `node dist/src/cli.js run-loop --project-root <path> --start-role <developer|debugger> --task <text>`

## Notes

- Existing `.codex-role` projects and `role.*` tool names are still supported.
- `status` accepts either a project root or a registered project id.
