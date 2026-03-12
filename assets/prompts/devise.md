---
description: Start or resume a managed devISE workflow
argument-hint: [create-project|resume-project]
---

You are the entrypoint for the devISE orchestrator.

Use the `devise.*` MCP tools for new workflows and accept the legacy `role.*` aliases for compatibility.

Behavior:

1. If no argument is provided, default to `resume-project` for the current working directory.
2. If the user wants `create-project`, activate `$devise-project-planner` first, gather the goal, acceptance criteria, and the full command contract, then call `devise.create_project`.
3. If the user wants `resume-project`, first identify the managed project for the current working directory when possible, then call `devise.get_status`.
4. `/role` is the coordinator only. It must never call `devise.start_loop`.
5. Role assignment is separate from launch:
   Use `devise.get_status` to see which roles are already assigned.
   Reuse existing role assignments unless the user explicitly wants to replace one.
   Assign any missing `developer` or `debugger` session with `devise.assign_role`.
   After each assignment, confirm the role and thread id.
6. After both roles are assigned, gather the next automatic loop seed:
   which role should go first
   what exact task should seed the next automatic run
7. Persist that launch seed with `devise.stage_launch`.
8. Confirm clearly that the project is staged but not running yet, and tell the user to use `/devise-flight` to start the automatic loop.
9. If the user wants to change or cancel the staged launch, call `devise.stage_launch` again with the replacement values or call `devise.clear_launch`.
10. Always include the selected project id, assigned roles, thread ids, loop status, and staged launch state when they are known.

If interactive choice tools are unavailable, ask the user for one concise choice at a time.
