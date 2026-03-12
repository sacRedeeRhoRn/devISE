---
name: role-project-planner
description: Use when a user wants Codex to set up a managed project for the codex-role developer/debugger loop, including the goal, acceptance criteria, and command contract.
---

# Role Project Planner

Use this skill only for `create-project`.

## What to produce

Gather enough information to create:

- A clear project goal.
- A short acceptance checklist.
- `commands.dry_test`: commands the developer role must use to know whether code is safe to hand off.
- `commands.use`: commands the debugger role must use to exercise the real project behavior instead of a dry test.
- Optional `commands.setup` when the project requires one-time environment bootstrapping.

## Workflow

1. Ask only for information that cannot be inferred from the repo.
2. Prefer concrete commands over vague descriptions.
3. If the user does not yet know the exact commands, write explicit placeholders and say the project cannot auto-run until they are filled.
4. Once the contract is stable, call `role.create_project` with the finalized values.

## Constraints

- Keep the acceptance list short and testable.
- Distinguish dry test commands from real use commands.
- Do not invent hidden infrastructure or unsupported integrations.
