import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { RoleService } from "../lib/service.js";

function structured(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

export async function startMcpServer(service: RoleService): Promise<void> {
  const server = new McpServer({
    name: "codex-role",
    version: "0.1.0",
  });

  server.registerTool(
    "role.create_project",
    {
      description:
        "Create a managed codex-role project scaffold with goal, acceptance criteria, and command contract.",
      inputSchema: {
        projectRoot: z.string(),
        goal: z.string(),
        acceptance: z.array(z.string()).optional(),
        dryTestCommands: z.array(z.string()).optional(),
        useCommands: z.array(z.string()).optional(),
        setupCommands: z.array(z.string()).optional(),
        projectId: z.string().optional(),
        controllerThreadId: z.string().optional(),
      },
    },
    async (input) => {
      const project = await service.createProject(input);
      return {
        content: [
          {
            type: "text",
            text: `Created project ${project.project.id} at ${project.project.root}`,
          },
        ],
        structuredContent: structured(project),
      };
    },
  );

  server.registerTool(
    "role.list_projects",
    {
      description: "List managed codex-role projects from the local registry.",
      inputSchema: {},
    },
    async () => {
      const projects = await service.listProjects();
      return {
        content: [
          {
            type: "text",
            text: projects
              .map((project) => `${project.project.id}: ${project.goal}`)
              .join("\n"),
          },
        ],
        structuredContent: structured({ projects }),
      };
    },
  );

  server.registerTool(
    "role.resolve_current_session",
    {
      description:
        "Resolve the most recently updated interactive Codex session for the given project root.",
      inputSchema: {
        projectRoot: z.string(),
      },
    },
    async ({ projectRoot }) => {
      const session = await service.resolveCurrentSession(projectRoot);
      return {
        content: [
          {
            type: "text",
            text: session
              ? `Resolved current session ${session.threadId}`
              : `No current session found for ${projectRoot}`,
          },
        ],
        structuredContent: structured({ session }),
      };
    },
  );

  server.registerTool(
    "role.list_recent_sessions",
    {
      description: "List recent same-cwd Codex sessions for a managed project.",
      inputSchema: {
        projectRoot: z.string(),
        limit: z.number().int().min(1).max(50).optional(),
      },
    },
    async ({ projectRoot, limit }) => {
      const sessions = await service.listRecentSessions(projectRoot, limit ?? 10);
      return {
        content: [
          {
            type: "text",
            text: sessions
              .map(
                (session) =>
                  `${session.threadId} ${session.updatedAt} ${session.preview}`,
              )
              .join("\n"),
          },
        ],
        structuredContent: structured({ sessions }),
      };
    },
  );

  server.registerTool(
    "role.assign_role",
    {
      description:
        "Assign the developer or debugger role to the current session or to a forked old session.",
      inputSchema: {
        projectRoot: z.string(),
        role: z.enum(["developer", "debugger"]),
        mode: z.enum(["current", "old"]),
        threadId: z.string().optional(),
        currentThreadId: z.string().optional(),
      },
    },
    async (input) => {
      const runtime = await service.assignRole(input);
      return {
        content: [
          {
            type: "text",
            text: `Assigned ${input.role} for ${runtime.projectId}`,
          },
        ],
        structuredContent: structured(runtime),
      };
    },
  );

  server.registerTool(
    "role.start_loop",
    {
      description:
        "Start the background developer/debugger loop for a managed project.",
      inputSchema: {
        projectRoot: z.string(),
        startRole: z.enum(["developer", "debugger"]),
      },
    },
    async (input) => {
      const runtime = await service.startLoop(input);
      return {
        content: [
          {
            type: "text",
            text: `Started loop for ${runtime.projectId} with pid ${runtime.loop.pid}`,
          },
        ],
        structuredContent: structured(runtime),
      };
    },
  );

  server.registerTool(
    "role.get_status",
    {
      description: "Get current runtime status for a managed project.",
      inputSchema: {
        projectRoot: z.string(),
      },
    },
    async ({ projectRoot }) => {
      const status = await service.getStatus(projectRoot);
      return {
        content: [
          {
            type: "text",
            text: `Project ${status.project.project.id}: ${status.runtime.loop.status}`,
          },
        ],
        structuredContent: structured(status),
      };
    },
  );

  server.registerTool(
    "role.stop_loop",
    {
      description: "Stop a running role controller for a managed project.",
      inputSchema: {
        projectRoot: z.string(),
      },
    },
    async ({ projectRoot }) => {
      const runtime = await service.stopLoop(projectRoot);
      return {
        content: [
          {
            type: "text",
            text: `Stopped loop for ${runtime.projectId}`,
          },
        ],
        structuredContent: structured(runtime),
      };
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
