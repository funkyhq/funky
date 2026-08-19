// The opt-in end-to-end proof — the P2 exit artifact: a real model, a
// real sandbox, a real postgres, and the real worker. The child process
// is apps/worker/src/main.ts itself — the same entry a container
// runs — so what passes here is the deployable artifact, not a fixture
// that mirrors it. Assertions are invariants over the store and the
// workspace, never transcripts: the model's words are its own; what must
// hold is the log's shape (every call resolved exactly once, terminal
// assistant tail), the registered sandbox binding, and the file the task
// asked for actually existing in the sandbox.
//
// Opt-in: set E2E_DATABASE_URL (a SCRATCH database — its public schema
// is dropped and recreated per run), ANTHROPIC_API_KEY and E2B_API_KEY.
// Cost per run: two short claude-haiku runs and two E2B sandboxes.

import { type ChildProcess, fork } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentMessage, SessionEntry, SessionId } from "@funky/core";
import { createE2bProvider, createPgStore, type StoreDb } from "@funky/adapters";

const url = process.env.E2E_DATABASE_URL;
const anthropicKey = process.env.ANTHROPIC_API_KEY;
const e2bKey = process.env.E2B_API_KEY;

if (!url || !anthropicKey || !e2bKey) {
  describe.skip("worker e2e", () => {
    it("skipped — set E2E_DATABASE_URL, ANTHROPIC_API_KEY and E2B_API_KEY to run", () => {});
  });
} else {
  const ddl = readFileSync(
    new URL("../../../packages/adapters/migrations/0000_init.sql", import.meta.url),
    "utf8",
  );
  const mainPath = fileURLToPath(new URL("../src/main.ts", import.meta.url));
  const pool = new Pool({ connectionString: url, max: 5 });
  const store = createPgStore(drizzle({ client: pool }) as unknown as StoreDb);
  const sandboxes = createE2bProvider({ apiKey: e2bKey });

  // Short lease so the kill test's re-claim happens in seconds; the
  // heartbeat keeps live steps alive regardless of duration.
  const LEASE_MS = 3_000;

  const workers: ChildProcess[] = [];
  const sessions: SessionId[] = [];

  beforeAll(async () => {
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await pool.query(ddl);
  });

  afterAll(async () => {
    for (const worker of workers) {
      if (worker.exitCode === null && worker.signalCode === null) worker.kill("SIGKILL");
    }
    // Orphan hygiene: kill the sandboxes the runs created.
    for (const sessionId of sessions) {
      const session = await store.getSession(sessionId);
      if (!session?.sandboxId) continue;
      await sandboxes
        .connect(session.sandboxId)
        .then((sandbox) => sandbox.kill())
        .catch(() => {});
    }
    await pool.end();
  });

  /** SIGKILL — the only shutdown the worker has, by design. */
  async function killWorker(worker: ChildProcess): Promise<void> {
    worker.kill("SIGKILL");
    await waitFor(
      () => Promise.resolve(worker.exitCode !== null || worker.signalCode !== null),
      10_000,
      "the killed worker to exit",
    );
  }

  function forkWorker(): ChildProcess {
    const worker = fork(mainPath, [], {
      execArgv: ["--import", "tsx"],
      env: {
        ...process.env,
        DATABASE_URL: url,
        ANTHROPIC_API_KEY: anthropicKey,
        E2B_API_KEY: e2bKey,
        FUNKY_LEASE_MS: String(LEASE_MS),
        FUNKY_IDLE_POLL_MS: "100",
        // Keep any sandbox this run orphans short-lived.
        FUNKY_SANDBOX_TIMEOUT_MS: "300000",
      },
    });
    workers.push(worker);
    return worker;
  }

  async function seedSession(task: string): Promise<SessionId> {
    const agentConfigId = await store.createAgentConfig({
      inference: {
        provider: "anthropic",
        model: "claude-haiku-4-5-20251001",
        maxTokens: 2048,
      },
      systemPrompt:
        "You are an agent in a fresh Linux sandbox. Complete the task with the " +
        "tools, then reply with a one-sentence summary. If a tool result says " +
        "the execution was interrupted, issue that call again.",
    });
    const envConfigId = await store.createEnvConfig({});
    const sessionId = await store.createSession({ agentConfigId, envConfigId });
    sessions.push(sessionId);
    const result = await store.intake(sessionId, {
      role: "user",
      content: [{ type: "text", text: task }],
    });
    expect(result.kind).toBe("started");
    return sessionId;
  }

  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  async function waitFor(
    check: () => Promise<boolean>,
    timeoutMs: number,
    label: string,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await check()) return;
      await sleep(250);
    }
    throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
  }

  // A run's end is the atomic NON-creation of a next item: all items done.
  async function runFinished(sessionId: SessionId): Promise<boolean> {
    const items = await store.listItems(sessionId);
    return items.length > 0 && items.every((item) => item.status === "done");
  }

  function messages(entries: SessionEntry[]): AgentMessage[] {
    return entries
      .sort((a, b) => a.seq - b.seq)
      .filter((entry) => entry.type === "message")
      .map((entry) => entry.message);
  }

  /** Every tool call in the log has exactly one result — across crashes. */
  function assertEveryCallResolvedOnce(entries: SessionEntry[]): void {
    const msgs = messages(entries);
    const callIds = msgs
      .filter((m) => m.role === "assistant")
      .flatMap((m) => m.content.filter((part) => part.type === "toolCall"))
      .map((call) => call.id);
    const resultIds = msgs.filter((m) => m.role === "toolResult").map((m) => m.toolCallId);
    expect([...resultIds].sort()).toEqual([...callIds].sort());
    expect(new Set(resultIds).size).toBe(resultIds.length);
  }

  describe("worker e2e", () => {
    it(
      "drives a real tool task end to end through the forked worker",
      { timeout: 180_000 },
      async () => {
        const sessionId = await seedSession(
          "Create a file at /home/user/hello.txt containing exactly: hello funky",
        );
        const worker = forkWorker();
        try {
          await waitFor(() => runFinished(sessionId), 150_000, "the run to finish");
        } finally {
          // Claims have no session filter: a worker that outlives its test
          // would steal the next test's items.
          await killWorker(worker);
        }

        const entries = await store.readEntries(sessionId);
        assertEveryCallResolvedOnce(entries);
        const msgs = messages(entries);
        const tail = msgs[msgs.length - 1];
        if (tail?.role !== "assistant") throw new Error("run did not end on an assistant message");
        expect(tail.stopReason).toBe("end_turn");
        expect(msgs.some((m) => m.role === "toolResult" && !m.isError)).toBe(true);

        // The workspace really changed: read the file back through the
        // provider, via the binding the driver registered.
        const session = await store.getSession(sessionId);
        if (!session?.sandboxId) throw new Error("no sandbox bound to the session");
        const sandbox = await sandboxes.connect(session.sandboxId);
        const bytes = await sandbox.readFile("/home/user/hello.txt");
        expect(new TextDecoder().decode(bytes).trim()).toBe("hello funky");
      },
    );

    it(
      "survives SIGKILL mid tool-execution: the re-claim interrupts, the model recovers",
      { timeout: 300_000 },
      async () => {
        // The sleep is the kill window: an execute_tools item stays leased
        // for its whole duration, so the parent reliably lands the SIGKILL
        // while tools are (or are about to be) executing.
        const sessionId = await seedSession(
          "First run the bash command `sleep 15`. Then create a file at " +
            "/home/user/done.txt containing exactly: recovered",
        );
        // `first` is the only live worker (each test kills its own), so
        // the leased claim below is provably the one the SIGKILL lands on.
        const first = forkWorker();
        await waitFor(
          async () => {
            const items = await store.listItems(sessionId);
            return items.some((item) => item.type === "execute_tools" && item.status === "leased");
          },
          120_000,
          "an execute_tools claim",
        );
        await killWorker(first);

        const resume = forkWorker();
        try {
          await waitFor(() => runFinished(sessionId), 240_000, "the resumed run to finish");
        } finally {
          await killWorker(resume);
        }

        const entries = await store.readEntries(sessionId);
        assertEveryCallResolvedOnce(entries);
        // The carve-out ran: the killed batch was re-claimed, not re-executed —
        // its calls settled as synthesized interrupted results.
        const items = await store.listItems(sessionId);
        expect(items.some((item) => item.type === "execute_tools" && item.attempt > 1)).toBe(true);
        const msgs = messages(entries);
        expect(
          msgs.some(
            (m) =>
              m.role === "toolResult" &&
              m.isError &&
              m.content.some((part) => part.type === "text" && part.text.includes("interrupted")),
          ),
        ).toBe(true);
        // And the model finished the job after the interruption.
        const tail = msgs[msgs.length - 1];
        if (tail?.role !== "assistant") throw new Error("run did not end on an assistant message");
        expect(tail.stopReason).toBe("end_turn");
      },
    );
  });
}
