import { EventEmitter } from "node:events";
import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";
import readline from "node:readline";

type JsonRpcId = number;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc?: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

interface JsonRpcNotification {
  jsonrpc?: "2.0";
  method: string;
  params?: unknown;
}

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
};

type SpawnAppServerProcess = (
  command: string,
  args: string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;

interface CodexAppServerClientOptions {
  command?: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  spawnImpl?: SpawnAppServerProcess;
}

export interface ThreadItemContentLike {
  type?: string;
  text?: string;
}

export interface ThreadItemLike {
  id: string;
  type: string;
  status?: string;
  text?: string;
  command?: string;
  cwd?: string;
  aggregatedOutput?: string;
  exitCode?: number;
  durationMs?: number;
  content?: ThreadItemContentLike[];
}

export interface ThreadTurnLike {
  id: string;
  status: string;
  startedAt?: string;
  completedAt?: string;
  items: ThreadItemLike[];
  error?: unknown;
}

export interface ThreadLike {
  id: string;
  preview: string;
  updatedAt: number;
  cwd: string;
  source: string;
  name: string | null;
  agentRole: string | null;
  status?: {
    type?: string;
  };
  turns: ThreadTurnLike[];
}

export class CodexAppServerClient extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<JsonRpcId, PendingRequest>();
  private ready = false;
  private connecting?: Promise<void>;
  private closing = false;

  constructor(private readonly options: CodexAppServerClientOptions = {}) {
    super();
  }

  async connect(): Promise<void> {
    if (this.ready) {
      return;
    }

    if (this.connecting) {
      await this.connecting;
      return;
    }

    this.connecting = this.initializeConnection();
    try {
      await this.connecting;
    } finally {
      this.connecting = undefined;
    }
  }

  async close(): Promise<void> {
    const child = this.child;
    if (!child) {
      this.ready = false;
      return;
    }

    this.closing = true;
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill("SIGKILL");
          }
        }, 1000);
        child.once("exit", () => {
          clearTimeout(timeout);
          resolve();
        });
        child.kill("SIGTERM");
      });
    }

    this.child = undefined;
    this.ready = false;
    this.closing = false;
  }

  async listThreads(params: Record<string, unknown>): Promise<ThreadLike[]> {
    const response = (await this.request("thread/list", params)) as {
      data: ThreadLike[];
    };
    return response.data;
  }

  async readThread(threadId: string, includeTurns = true): Promise<ThreadLike> {
    const response = (await this.request("thread/read", {
      threadId,
      includeTurns,
    })) as { thread: ThreadLike };
    return response.thread;
  }

  async startThread(params: Record<string, unknown>): Promise<ThreadLike> {
    const response = (await this.request("thread/start", params)) as {
      thread: ThreadLike;
    };
    return response.thread;
  }

  async resumeThread(params: Record<string, unknown>): Promise<ThreadLike> {
    const response = (await this.request("thread/resume", params)) as {
      thread: ThreadLike;
    };
    return response.thread;
  }

  async forkThread(params: Record<string, unknown>): Promise<ThreadLike> {
    const response = (await this.request("thread/fork", params)) as {
      thread: ThreadLike;
    };
    return response.thread;
  }

  async setThreadName(threadId: string, name: string): Promise<void> {
    await this.request("thread/name/set", { threadId, name });
  }

  async getConversationSummary(params: Record<string, unknown>): Promise<unknown> {
    return this.request("getConversationSummary", params);
  }

  async startTurn(params: Record<string, unknown>): Promise<void> {
    await this.request("turn/start", params);
  }

  async waitForTurnCompletion(
    threadId: string,
    timeoutMs = 30 * 60 * 1000,
    priorTurnCount = 0,
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let pollTimer: NodeJS.Timeout | undefined;
      let settled = false;
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out waiting for turn completion on thread ${threadId}`));
      }, timeoutMs);

      const onNotification = (notification: JsonRpcNotification) => {
        if (notification.method === "thread/status/changed") {
          const payload = notification.params as {
            threadId?: string;
            status?: { type?: string };
          };
          if (payload.threadId === threadId && payload.status?.type === "idle") {
            cleanup();
            resolve();
          }
          return;
        }

        if (!["turn/completed", "turn/failed", "turn/interrupted"].includes(notification.method)) {
          return;
        }

        const payload = notification.params as { threadId?: string };
        if (payload.threadId === threadId) {
          cleanup();
          resolve();
        }
      };

      const cleanup = () => {
        settled = true;
        clearTimeout(timeout);
        if (pollTimer) {
          clearTimeout(pollTimer);
        }
        this.off("notification", onNotification);
      };

      const pollThreadState = async (): Promise<void> => {
        try {
          const thread = await this.readThread(threadId, true);
          const lastTurn = thread.turns.at(-1);
          if (
            thread.turns.length > priorTurnCount &&
            lastTurn &&
            ["completed", "failed", "interrupted"].includes(lastTurn.status)
          ) {
            cleanup();
            resolve();
            return;
          }
        } catch (error) {
          cleanup();
          reject(error instanceof Error ? error : new Error(String(error)));
          return;
        }

        if (!settled) {
          pollTimer = setTimeout(() => {
            void pollThreadState();
          }, 1000);
        }
      };

      this.on("notification", onNotification);
      pollTimer = setTimeout(() => {
        void pollThreadState();
      }, 1000);
    });
  }

  async request<T>(method: string, params?: unknown): Promise<T> {
    await this.connect();
    return this.requestOnce<T>(method, params);
  }

  private async initializeConnection(): Promise<void> {
    this.child = (this.options.spawnImpl ?? spawn)(
      this.options.command ?? "codex",
      this.options.args ?? ["app-server", "--listen", "stdio://"],
      {
      stdio: ["pipe", "pipe", "pipe"],
        env: this.options.env,
      },
    );

    this.child.on("exit", (code, signal) => {
      const closing = this.closing;
      const error = new Error(
        `codex app-server exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "null"})`,
      );
      for (const pending of this.pending.values()) {
        pending.reject(error);
      }
      this.pending.clear();
      this.child = undefined;
      this.ready = false;
      this.closing = false;
      if (!closing) {
        this.emit("exit", error);
      }
    });

    const stdoutReader = readline.createInterface({ input: this.child.stdout });
    stdoutReader.on("line", (line) => {
      if (line.trim().length === 0) {
        return;
      }
      this.handleLine(line);
    });

    const stderrReader = readline.createInterface({ input: this.child.stderr });
    stderrReader.on("line", (line) => {
      this.emit("stderr", line);
    });

    try {
      await this.requestOnce("initialize", {
        clientInfo: {
          name: "devISE",
          version: "0.1.0",
        },
        capabilities: {
          experimentalApi: true,
        },
      });
      this.sendNotification("initialized");
      this.ready = true;
    } catch (error) {
      this.ready = false;
      const child = this.child;
      this.child = undefined;
      if (child && !child.killed) {
        child.kill("SIGTERM");
      }
      throw error;
    }
  }

  private async requestOnce<T>(method: string, params?: unknown): Promise<T> {
    const child = this.requireChild();
    const id = this.nextId++;
    const payload: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };

    const response = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
    });
    child.stdin.write(`${JSON.stringify(payload)}\n`);
    return response;
  }

  private sendNotification(method: string, params?: unknown): void {
    const child = this.requireChild();
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        method,
        params,
      })}\n`,
    );
  }

  private requireChild(): ChildProcessWithoutNullStreams {
    const child = this.child;
    if (!child) {
      throw new Error("codex app-server is not running");
    }
    return child;
  }

  private handleLine(line: string): void {
    let parsed: JsonRpcNotification | JsonRpcResponse | JsonRpcRequest;
    try {
      parsed = JSON.parse(line) as JsonRpcNotification | JsonRpcResponse | JsonRpcRequest;
    } catch (error) {
      this.emit("stderr", `Failed to parse app-server output: ${line}`);
      return;
    }

    if ("id" in parsed && ("result" in parsed || "error" in parsed)) {
      const pending = this.pending.get(parsed.id);
      if (!pending) {
        return;
      }
      this.pending.delete(parsed.id);
      if (parsed.error) {
        pending.reject(
          new Error(`${parsed.error.message} (code ${parsed.error.code})`),
        );
      } else {
        pending.resolve(parsed.result);
      }
      return;
    }

    if ("method" in parsed && "id" in parsed) {
      void this.handleServerRequest(parsed);
      return;
    }

    if ("method" in parsed) {
      this.emit("notification", parsed);
    }
  }

  private async handleServerRequest(request: JsonRpcRequest): Promise<void> {
    const child = this.child;
    if (!child) {
      return;
    }

    let result: unknown;
    switch (request.method) {
      case "item/commandExecution/requestApproval":
        result = { decision: "approve" };
        break;
      case "item/fileChange/requestApproval":
        result = { decision: "approve" };
        break;
      case "item/permissions/requestApproval":
        result = {
          permissions: requestedPermissions(request.params),
          scope: "session",
        };
        break;
      case "execCommandApproval":
      case "applyPatchApproval":
        result = { decision: "approved" };
        break;
      case "item/tool/requestUserInput":
        result = { answers: {} };
        break;
      default:
        child.stdin.write(
          `${JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            error: {
              code: -32601,
              message: `Unsupported server request: ${request.method}`,
            },
          })}\n`,
        );
        return;
    }

    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: request.id,
        result,
      })}\n`,
    );
  }
}

function requestedPermissions(params: unknown): unknown {
  if (typeof params !== "object" || params === null || !("permissions" in params)) {
    return {};
  }

  return (params as { permissions: unknown }).permissions ?? {};
}
