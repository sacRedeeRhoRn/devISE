import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";

import { CodexAppServerClient } from "../src/lib/appServerClient.js";

test("CodexAppServerClient initializes once and serves requests", async () => {
  const spawnCalls: Array<{
    command: string;
    args: readonly string[];
    options: SpawnOptionsWithoutStdio | undefined;
  }> = [];
  const client = new CodexAppServerClient({
    spawnImpl(command, args, options) {
      spawnCalls.push({
        command,
        args: args ?? [],
        options,
      });
      return createFakeAppServerChild((request, child) => {
        if (request.method === "thread/list") {
          child.respond(request.id, {
            result: {
              data: [
                {
                  id: "thread-1",
                  preview: "preview",
                  updatedAt: 0,
                  cwd: process.cwd(),
                  source: "cli",
                  name: null,
                  agentRole: null,
                  turns: [],
                },
              ],
            },
          });
          return true;
        }
        return false;
      });
    },
  });

  try {
    const threads = await client.listThreads({ cwd: process.cwd() });
    assert.equal(threads.length, 1);
    assert.equal(threads[0]?.id, "thread-1");
    assert.equal(spawnCalls.length, 1);
    assert.equal(spawnCalls[0]?.command, "codex");
    assert.deepEqual(spawnCalls[0]?.args, ["app-server", "--listen", "stdio://"]);
  } finally {
    await client.close();
  }
});

test("waitForTurnCompletion resolves when the thread returns to idle", async () => {
  const client = new CodexAppServerClient({
    spawnImpl() {
      return createFakeAppServerChild((request, child) => {
        if (request.method === "turn/start") {
          setTimeout(() => {
            child.notify("thread/status/changed", {
              threadId: "thread-1",
              status: { type: "idle" },
            });
          }, 20);
          child.respond(request.id, { result: {} });
          return true;
        }

        return false;
      });
    },
  });

  try {
    await client.startTurn({ threadId: "thread-1", input: [] });
    await client.waitForTurnCompletion("thread-1", 5000);
  } finally {
    await client.close();
  }
});

test("waitForTurnCompletion polls thread state when notifications are missing", async () => {
  let readCount = 0;
  const client = new CodexAppServerClient({
    spawnImpl() {
      return createFakeAppServerChild((request, child) => {
        if (request.method === "turn/start") {
          child.respond(request.id, { result: {} });
          return true;
        }

        if (request.method === "thread/read") {
          readCount += 1;
          child.respond(request.id, {
            result: {
              thread: {
                id: "thread-1",
                preview: "preview",
                updatedAt: 0,
                cwd: process.cwd(),
                source: "cli",
                name: null,
                agentRole: null,
                turns:
                  readCount < 2
                    ? [
                        {
                          id: "turn-1",
                          status: "inProgress",
                          items: [],
                        },
                      ]
                    : [
                        {
                          id: "turn-1",
                          status: "interrupted",
                          items: [],
                        },
                      ],
              },
            },
          });
          return true;
        }

        return false;
      });
    },
  });

  try {
    await client.startTurn({ threadId: "thread-1", input: [] });
    await client.waitForTurnCompletion("thread-1", 5000, 0);
    assert.ok(readCount >= 2);
  } finally {
    await client.close();
  }
});

test("CodexAppServerClient approves managed access requests", async () => {
  let fakeChild: FakeAppServerChild | undefined;
  const client = new CodexAppServerClient({
    spawnImpl() {
      fakeChild = createFakeAppServerChild();
      return fakeChild;
    },
  });

  try {
    await client.connect();
    assert.ok(fakeChild);

    const commandApproval = await fakeChild.requestClient(
      41,
      "item/commandExecution/requestApproval",
      {
        command: "ssh msj@example.com",
      },
    );
    assert.deepEqual(commandApproval.result, { decision: "approve" });

    const fileApproval = await fakeChild.requestClient(42, "item/fileChange/requestApproval", {
      changes: [{ path: "/tmp/test.txt" }],
    });
    assert.deepEqual(fileApproval.result, { decision: "approve" });

    const requestedPermissions = {
      network: { mode: "enabled" },
      filesystem: { mode: "full-access" },
    };
    const permissionsApproval = await fakeChild.requestClient(
      43,
      "item/permissions/requestApproval",
      {
        permissions: requestedPermissions,
      },
    );
    assert.deepEqual(permissionsApproval.result, {
      permissions: requestedPermissions,
      scope: "session",
    });

    const execApproval = await fakeChild.requestClient(44, "execCommandApproval", {
      command: ["qsub", "job.sh"],
    });
    assert.deepEqual(execApproval.result, { decision: "approved" });
  } finally {
    await client.close();
  }
});

interface FakeAppServerChild extends ChildProcessWithoutNullStreams {
  requestClient: (id: number, method: string, params?: unknown) => Promise<JsonRpcResponseLike>;
}

interface JsonRpcResponseLike {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
  };
}

function createFakeAppServerChild(
  onRequest?: (
    request: { id?: number; method?: string; params?: unknown },
    child: {
      respond: (id: number | undefined, payload: Record<string, unknown>) => void;
      notify: (method: string, params: Record<string, unknown>) => void;
    },
  ) => boolean,
): FakeAppServerChild {
  class FakeChild extends EventEmitter {
    stdin = new PassThrough();
    stdout = new PassThrough();
    stderr = new PassThrough();
    stdio = [this.stdin, this.stdout, this.stderr] as const;
    pid = 12345;
    connected = false;
    spawnfile = "codex";
    spawnargs = ["app-server", "--listen", "stdio://"];
    killed = false;
    exitCode: number | null = null;
    signalCode: NodeJS.Signals | null = null;
    private buffer = "";
    private pendingClientResponses = new Map<number, (message: JsonRpcResponseLike) => void>();

    constructor() {
      super();
      this.stdin.setEncoding("utf8");
      this.stdin.on("data", (chunk) => {
        this.buffer += chunk;
        while (this.buffer.includes("\n")) {
          const index = this.buffer.indexOf("\n");
          const line = this.buffer.slice(0, index);
          this.buffer = this.buffer.slice(index + 1);
          this.handleLine(line);
        }
      });
    }

    kill(signal: NodeJS.Signals | number = "SIGTERM"): boolean {
      if (this.exitCode !== null || this.signalCode !== null) {
        return false;
      }

      this.killed = true;
      this.signalCode = typeof signal === "string" ? signal : "SIGTERM";
      queueMicrotask(() => {
        this.stdin.end();
        this.stdout.end();
        this.stderr.end();
        this.emit("exit", null, this.signalCode);
      });
      return true;
    }

    requestClient(id: number, method: string, params?: unknown): Promise<JsonRpcResponseLike> {
      return new Promise((resolve) => {
        this.pendingClientResponses.set(id, resolve);
        this.stdout.write(
          `${JSON.stringify({
            jsonrpc: "2.0",
            id,
            method,
            params,
          })}\n`,
        );
      });
    }

    private handleLine(line: string): void {
      if (!line.trim()) {
        return;
      }

      const request = JSON.parse(line) as {
        id?: number;
        method?: string;
        result?: unknown;
        error?: {
          code: number;
          message: string;
        };
      };
      if (!request.method && request.id && this.pendingClientResponses.has(request.id)) {
        this.pendingClientResponses.get(request.id)?.({
          jsonrpc: "2.0",
          id: request.id,
          result: request.result,
          error: request.error,
        });
        this.pendingClientResponses.delete(request.id);
        return;
      }

      if (request.method === "initialize" && request.id) {
        this.respond(request.id, { result: {} });
        return;
      }

      if (request.method === "initialized") {
        return;
      }

      if (
        onRequest?.(request, {
          respond: (id, payload) => this.respond(id, payload),
          notify: (method, params) => this.notify(method, params),
        })
      ) {
        return;
      }

      if (request.id) {
        this.respond(request.id, {
          error: {
            code: -32601,
            message: "unsupported",
          },
        });
      }
    }

    private respond(id: number | undefined, payload: Record<string, unknown>): void {
      this.stdout.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id,
          ...payload,
        })}\n`,
      );
    }

    private notify(method: string, params: Record<string, unknown>): void {
      this.stdout.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          method,
          params,
        })}\n`,
      );
    }
  }

  return new FakeChild() as unknown as FakeAppServerChild;
}
