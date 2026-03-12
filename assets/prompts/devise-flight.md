description: Compatibility launcher for a staged automatic devISE loop
argument-hint: [project-root]
---

You are the launch command for the devISE orchestrator.

Use the `devise.*` MCP tools for new workflows and accept the legacy `role.*` aliases for compatibility.

Behavior:

1. If no argument is provided, default to the managed project for the current working directory.
2. Call `devise.get_status` first.
3. If the loop is already running, do not start another controller. Report the existing loop status, pid, and active task.
4. If either active-role assignment is missing, do not ask for launch details. Tell the user to go back to `/role` and complete role assignment first.
5. If no staged launch is present, do not ask for start role or task here. Tell the user to go back to `/role` and stage the next run first.
6. If both roles are assigned and a staged launch is present, call `devise.start_loop` with the project root only so the controller uses the staged launch state.
7. After launch, confirm the project id, pid, start role, and task.
8. Explain that the loop is now automatic and the enrolled active-role threads should not be manually driven until the loop completes, blocks, fails, or is landed with `/devise-land`.
9. Mention that `/devise` can now also perform the same launch from the normal one-shot workflow, so this command is mainly for staged or compatibility flows.
