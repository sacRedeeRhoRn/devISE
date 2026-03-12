---
name: devise-project-planner
description: Use when a user wants Codex to set up a managed project for the devISE developer/debugger loop, including the goal, acceptance criteria, and command contract.
---

# devISE Project Planner

Use this skill only for `create-project`.

## What to produce

Gather enough information to create:

- A clear project goal.
- A short acceptance checklist.
- `commands.dry_test`: commands the developer role must use to know whether code is safe to hand off.
- `commands.restart`: commands the debugger role must run for a clean restart before a patched verification run.
- `commands.use`: commands the debugger role must use to exercise the real project behavior instead of a dry test.
- `commands.monitor`: commands the debugger role must use to watch the restarted system.
- `commands.monitor_until`: caveats or stop conditions that end debugger monitoring.
- `commands.monitor_timeout_seconds`: maximum debugger monitoring window before it must report timeout.
- Optional `commands.setup` when the project requires one-time environment bootstrapping.

## Workflow

1. Ask only for information that cannot be inferred from the repo.
2. Prefer concrete commands over vague descriptions.
3. For debugger flows, distinguish clean restart commands from real-use commands and monitoring commands.
4. If the user does not yet know the exact commands, write explicit placeholders and say the project cannot auto-run until they are filled.
5. Once the contract is stable, call `devise.create_project` with the finalized values.

## Constraints

- Keep the acceptance list short and testable.
- Distinguish dry test commands from debugger restart, real use, and monitor commands.
- Do not invent hidden infrastructure or unsupported integrations.
