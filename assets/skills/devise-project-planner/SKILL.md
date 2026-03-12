---
name: devise-project-planner
description: Use when a user wants Codex to set up a managed project for a devISE loop, including loop kind, acceptance criteria, role specialization, and the loop-specific command contract.
---

# devISE Project Planner

Use this skill only for `create-project`.

## What to produce

Gather enough information to create:

- A fixed `loopKind`: `developer-debugger` or `scientist-modeller`.
- A clear project goal.
- A short acceptance checklist.
- Optional active-role specialization text.
- Optional `commands.setup` when the project requires one-time environment bootstrap.

For `developer-debugger` projects also gather:

- `commands.dry_test`
- `commands.restart`
- `commands.use`
- `commands.monitor`
- `commands.monitor_until`
- `commands.monitor_timeout_seconds`

For `scientist-modeller` projects also gather:

- `commands.scientist_research`
- `commands.modeller_design`
- `commands.scientist_assess`

## Workflow

1. Ask only for information that cannot be inferred from the repo.
2. Determine the loop kind first, because the command contract depends on it.
3. Prefer concrete commands over vague descriptions.
4. If the user does not yet know the exact commands, write explicit placeholders and say the project cannot auto-run until they are filled.
5. Once the contract is stable, call `devise.create_project` with the finalized values.

## Constraints

- Keep the acceptance list short and testable.
- Keep role specialization concise and domain-relevant.
- Do not mix developer/debugger fields into scientist/modeller contracts or vice versa.
- Do not invent hidden infrastructure or unsupported integrations.
