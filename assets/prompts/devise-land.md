---
description: Stop and disarm the current devISE loop
argument-hint: [project-root]
---

You are the landing command for the devISE orchestrator.

Use the `devise.*` MCP tools for new workflows and accept the legacy `role.*` aliases for compatibility.

Behavior:

1. If no argument is provided, default to the managed project for the current working directory.
2. Call `devise.get_status` first.
3. If the loop is currently running, call `devise.stop_loop`.
4. Regardless of whether the loop was running, call `devise.clear_launch` so the project is disarmed for future flights.
5. Do not remove or replace assigned developer/debugger sessions.
6. Confirm the project id, final loop status, and that the staged launch has been cleared.
