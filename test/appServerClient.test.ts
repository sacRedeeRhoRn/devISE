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
      return createFakeAppServerChild();
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

function createFakeAppServerChild(): ChildProcessWithoutNullStreams {
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

    private handleLine(line: string): void {
      if (!line.trim()) {
        return;
      }

      const request = JSON.parse(line) as {
        id?: number;
        method?: string;
      };
      if (request.method === "initialize" && request.id) {
        this.respond(request.id, { result: {} });
        return;
      }

      if (request.method === "initialized") {
        return;
      }

      if (request.method === "thread/list" && request.id) {
        this.respond(request.id, {
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

    private respond(id: number, payload: Record<string, unknown>): void {
      this.stdout.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id,
          ...payload,
        })}\n`,
      );
    }
  }

  return new FakeChild() as unknown as ChildProcessWithoutNullStreams;
}
