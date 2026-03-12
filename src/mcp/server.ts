import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { RoleService } from "../lib/service.js";

function structured(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

export async function startMcpServer(service: RoleService): Promise<void> {
  const server = new McpServer({
    name: "devISE",
    version: "0.1.0",
  });

  registerWorkflowNamespace(server, service, "devise");
  registerWorkflowNamespace(server, service, "role");

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function registerWorkflowNamespace(
  server: McpServer,
  service: RoleService,
  namespace: "devise" | "role",
): void {
  server.registerTool(
    `${namespace}.create_project`,
    {
      description:
        "Create a managed devISE project scaffold with goal, acceptance criteria, and command contract.",
      inputSchema: {
        projectRoot: z.string(),
        goal: z.string(),
        acceptance: z.array(z.string()).optional(),
        dryTestCommands: z.array(z.string()).optional(),
        restartCommands: z.array(z.string()).optional(),
        useCommands: z.array(z.string()).optional(),
        monitorCommands: z.array(z.string()).optional(),
        monitorUntil: z.array(z.string()).optional(),
        monitorTimeoutSeconds: z.number().int().min(1).optional(),
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
    `${namespace}.list_projects`,
    {
      description: "List managed devISE projects from the local registry.",
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
    `${namespace}.resolve_current_session`,
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
    `${namespace}.list_recent_sessions`,
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
    `${namespace}.assign_role`,
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
      const assigned = runtime.roles[input.role];
      return {
        content: [
          {
            type: "text",
            text: `Assigned ${input.role} for ${runtime.projectId} to thread ${assigned?.threadId ?? "unknown"}`,
          },
        ],
        structuredContent: structured(runtime),
      };
    },
  );

  server.registerTool(
    `${namespace}.start_loop`,
    {
      description:
        "Start the background developer/debugger loop for a managed project using a specific user-requested task and starting role.",
      inputSchema: {
        projectRoot: z.string(),
        startRole: z.enum(["developer", "debugger"]),
        task: z.string().min(1),
      },
    },
    async ({ projectRoot, startRole, task }) => {
      const runtime = await service.startLoop({ projectRoot, startRole, task });
      return {
        content: [
          {
            type: "text",
            text: `Started loop for ${runtime.projectId} with pid ${runtime.loop.pid} on ${startRole} for task: ${task}`,
          },
        ],
        structuredContent: structured(runtime),
      };
    },
  );

  server.registerTool(
    `${namespace}.get_status`,
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
    `${namespace}.stop_loop`,
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
}
