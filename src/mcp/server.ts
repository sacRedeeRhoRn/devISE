import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { RoleService } from "../lib/service.js";
import { LOOP_KINDS, ROLE_KINDS } from "../lib/types.js";

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
        "Create a managed devISE project scaffold with loop kind, acceptance criteria, and loop-specific command contract.",
      inputSchema: {
        projectRoot: z.string(),
        loopKind: z.enum(LOOP_KINDS),
        goal: z.string(),
        domain: z.string().optional(),
        headProjectId: z.string().optional(),
        acceptance: z.array(z.string()).optional(),
        dryTestCommands: z.array(z.string()).optional(),
        restartCommands: z.array(z.string()).optional(),
        useCommands: z.array(z.string()).optional(),
        monitorCommands: z.array(z.string()).optional(),
        monitorUntil: z.array(z.string()).optional(),
        monitorTimeoutSeconds: z.number().int().min(1).optional(),
        scientistResearchCommands: z.array(z.string()).optional(),
        modellerDesignCommands: z.array(z.string()).optional(),
        scientistAssessCommands: z.array(z.string()).optional(),
        setupCommands: z.array(z.string()).optional(),
        projectId: z.string().optional(),
        controllerThreadId: z.string().optional(),
        developerSpecialization: z.string().optional(),
        debuggerSpecialization: z.string().optional(),
        scientistSpecialization: z.string().optional(),
        modellerSpecialization: z.string().optional(),
      },
    },
    async (input) => {
      const project = await service.createProject(input);
      return {
        content: [
          {
            type: "text",
            text: `Created project ${project.project.id} at ${project.project.root} in domain ${project.charter?.domain ?? project.domain ?? "unknown"}`,
          },
        ],
        structuredContent: structured(project),
      };
    },
  );

  server.registerTool(
    `${namespace}.create_portfolio`,
    {
      description:
        "Create a non-runnable devISE portfolio container with shared domain and persona-bias defaults.",
      inputSchema: {
        portfolioId: z.string().optional(),
        title: z.string(),
        goal: z.string(),
        domain: z.string().optional(),
        summary: z.string().optional(),
        developerPersonaHint: z.string().optional(),
        debuggerPersonaHint: z.string().optional(),
        scientistPersonaHint: z.string().optional(),
        modellerPersonaHint: z.string().optional(),
      },
    },
    async (input) => {
      const portfolio = await service.createPortfolio(input);
      return {
        content: [
          {
            type: "text",
            text: `Created portfolio ${portfolio.id}${portfolio.domain ? ` in ${portfolio.domain}` : ""}`,
          },
        ],
        structuredContent: structured({ portfolio }),
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
    `${namespace}.list_registry`,
    {
      description:
        "List devISE portfolios and managed projects with parent-child relationships and live runtime summaries.",
      inputSchema: {},
    },
    async () => {
      const overview = await service.listRegistryOverview();
      const lines = [
        ...overview.portfolios.map(
          (portfolio) =>
            `portfolio ${portfolio.id}: ${portfolio.title} (${portfolio.projects.length} projects)`,
        ),
        ...overview.topLevelProjects.map(
          (project) => `project ${project.id}: ${project.title} [${project.loopStatus}]`,
        ),
      ];
      return {
        content: [
          {
            type: "text",
            text: lines.join("\n"),
          },
        ],
        structuredContent: structured(overview),
      };
    },
  );

  server.registerTool(
    `${namespace}.move_project`,
    {
      description: "Logically move a managed project under a different portfolio or back to top-level.",
      inputSchema: {
        projectSelector: z.string(),
        newHeadProjectId: z.string().nullable().optional(),
      },
    },
    async ({ projectSelector, newHeadProjectId }) => {
      const entry = await service.moveProject({ projectSelector, newHeadProjectId });
      return {
        content: [
          {
            type: "text",
            text: `Moved project ${entry.id} to parent ${entry.parentId ?? "none"}`,
          },
        ],
        structuredContent: structured({ entry }),
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
        "Assign one active project role to a fresh managed session, the current session, or a forked old session.",
      inputSchema: {
        projectRoot: z.string(),
        role: z.enum(ROLE_KINDS),
        mode: z.enum(["new", "current", "old"]),
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
    `${namespace}.stage_launch`,
    {
      description:
        "Stage the next automatic loop launch for a managed project without starting the controller yet.",
      inputSchema: {
        projectRoot: z.string(),
        startRole: z.enum(ROLE_KINDS),
        task: z.string().min(1),
      },
    },
    async ({ projectRoot, startRole, task }) => {
      const runtime = await service.stageLaunch({ projectRoot, startRole, task });
      return {
        content: [
          {
            type: "text",
            text: `Staged launch for ${runtime.projectId} on ${runtime.launch.stagedStartRole} with task: ${runtime.launch.stagedTask}`,
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
        "Start the background role loop for a managed project using staged launch state or explicit start parameters.",
      inputSchema: {
        projectRoot: z.string(),
        startRole: z.enum(ROLE_KINDS).optional(),
        task: z.string().min(1).optional(),
      },
    },
    async ({ projectRoot, startRole, task }) => {
      const runtime = await service.startLoop({ projectRoot, startRole, task });
      return {
        content: [
          {
            type: "text",
            text: `Started loop for ${runtime.projectId} with pid ${runtime.loop.pid} on ${runtime.loop.startRole} for task: ${runtime.loop.task}`,
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
      const armed = Boolean(
        status.runtime.launch.stagedStartRole && status.runtime.launch.stagedTask,
      );
      return {
        content: [
          {
            type: "text",
            text: `Project ${status.project.project.id}: kind=${status.registryEntry?.kind ?? "managed_project"} loop=${status.runtime.loop.status} armed=${armed} domain=${status.project.charter?.domain ?? status.project.domain ?? "unknown"}`,
          },
        ],
        structuredContent: structured(status),
      };
    },
  );

  server.registerTool(
    `${namespace}.clear_launch`,
    {
      description: "Clear the staged launch state for a managed project without changing role assignments.",
      inputSchema: {
        projectRoot: z.string(),
      },
    },
    async ({ projectRoot }) => {
      const runtime = await service.clearLaunch(projectRoot);
      return {
        content: [
          {
            type: "text",
            text: `Cleared staged launch for ${runtime.projectId}`,
          },
        ],
        structuredContent: structured(runtime),
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
