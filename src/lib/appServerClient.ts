import { EventEmitter } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
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

export interface ThreadLike {
  id: string;
  preview: string;
  updatedAt: number;
  cwd: string;
  source: string;
  name: string | null;
  agentRole: string | null;
  turns: Array<{
    id: string;
    status: string;
    items: Array<{ type: string; text?: string }>;
    error?: unknown;
  }>;
}

export class CodexAppServerClient extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<JsonRpcId, PendingRequest>();
  private ready = false;

  async connect(): Promise<void> {
    if (this.ready) {
      return;
    }

    this.child = spawn("codex", ["app-server", "--listen", "stdio://"], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.child.on("exit", (code, signal) => {
      const error = new Error(
        `codex app-server exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "null"})`,
      );
      for (const pending of this.pending.values()) {
        pending.reject(error);
      }
      this.pending.clear();
      this.ready = false;
      this.emit("exit", error);
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

    await this.request("initialize", {
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
  }

  async close(): Promise<void> {
    if (!this.child) {
      return;
    }

    this.child.kill("SIGTERM");
    this.child = undefined;
    this.ready = false;
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
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out waiting for turn completion on thread ${threadId}`));
      }, timeoutMs);

      const onNotification = (notification: JsonRpcNotification) => {
        if (notification.method !== "turn/completed") {
          return;
        }

        const payload = notification.params as { threadId?: string };
        if (payload.threadId !== threadId) {
          return;
        }

        cleanup();
        resolve();
      };

      const cleanup = () => {
        clearTimeout(timeout);
        this.off("notification", onNotification);
      };

      this.on("notification", onNotification);
    });
  }

  async request<T>(method: string, params?: unknown): Promise<T> {
    await this.connect();
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
        result = { decision: "decline" };
        break;
      case "item/fileChange/requestApproval":
        result = { decision: "decline" };
        break;
      case "item/permissions/requestApproval":
        result = { permissions: {}, scope: "turn" };
        break;
      case "execCommandApproval":
      case "applyPatchApproval":
        result = { decision: "denied" };
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
