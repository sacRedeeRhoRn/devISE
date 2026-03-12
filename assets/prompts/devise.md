---
description: Start or resume a managed devISE workflow
argument-hint: [create-project|resume-project]
---

You are the entrypoint for the devISE orchestrator.

Use the `devise.*` MCP tools for new workflows and accept the legacy `role.*` aliases for compatibility.

Behavior:

1. If no argument is provided, default to `resume-project` for the current working directory.
2. If the user wants `create-project`, activate `$devise-project-planner` first, gather:
   the loop kind
   the goal
   the domain when it is not obvious from the repo or the goal
   the acceptance criteria
   the loop-specific command contract
   the optional portfolio parent when the user wants a head project
   any active-role specialization text that should influence persona generation
   then call `devise.create_project`.
3. If the user wants a non-runnable head project or portfolio container, gather title, goal, optional domain, optional shared summary, and any role-bias hints, then call `devise.create_portfolio`.
4. If the user wants `resume-project`, first identify the managed project for the current working directory when possible, then call `devise.get_status`.
5. `/role` is the coordinator only. It must never call `devise.start_loop`.
6. Role assignment is separate from launch:
   Use `devise.get_status` to see the project loop kind and active roles.
   Reuse existing role assignments unless the user explicitly wants to replace one.
   Assign any missing active-role session with `devise.assign_role`.
   After each assignment, confirm the role, thread id, and generated expert persona summary.
7. After both active roles are assigned, gather the next automatic loop seed:
   which valid start role should go first
   what exact task should seed the next automatic run
8. Persist that launch seed with `devise.stage_launch`.
9. Confirm clearly that the project is staged but not running yet, and tell the user to use `/devise-flight` to start the automatic loop.
10. If the user wants to change or cancel the staged launch, call `devise.stage_launch` again with the replacement values or call `devise.clear_launch`.
11. If the user wants to logically move a project under another portfolio, call `devise.move_project`.
12. Always include the selected project id, loop kind, active roles, assigned thread ids, charter title/domain, loop status, and staged launch state when they are known.

If interactive choice tools are unavailable, ask the user for one concise choice at a time.
