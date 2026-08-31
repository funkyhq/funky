// The opt-in end-to-end proofs. "worker e2e" is the P2 exit artifact: a
// real model, a real sandbox, a real postgres, and the real worker. The
// child process is apps/worker/src/main.ts itself — the same entry a
// container runs — so what passes here is the deployable artifact, not a
// fixture that mirrors it. "stack e2e" is the P3 exit artifact: the real
// api forked beside the real worker, seeded and observed exclusively
// over HTTP — postgres the only rendezvous — with a SIGKILL mid-run and
// an SSE reconnect-with-cursor across it. Assertions are invariants over
// the log and the workspace, never transcripts: the model's words are
// its own; what must hold is the log's shape (every call resolved
// exactly once, terminal assistant tail), the registered sandbox
// binding, and the file the task asked for actually existing in the
// sandbox.
//
// Opt-in: set E2E_DATABASE_URL (a SCRATCH database — its public schema
// is dropped and recreated per run), ANTHROPIC_API_KEY and E2B_API_KEY.
// Cost per run: three short claude-haiku runs and three E2B sandboxes.
// The describes share one schema and claims have no session filter, so
// every test SIGKILLs its own workers before the next begins.

import { type ChildProcess, fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_NAMESPACE,
  type AgentMessage,
  type SessionEntry,
  type SessionRef,
} from "@funky/core";
import { createE2bProvider, createPgStore, type StoreDb } from "@funky/adapters";
import { storeDdl } from "../../../packages/adapters/test/store-ddl";

const url = process.env.E2E_DATABASE_URL;
const anthropicKey = process.env.ANTHROPIC_API_KEY;
const e2bKey = process.env.E2B_API_KEY;

if (!url || !anthropicKey || !e2bKey) {
  describe.skip("worker e2e", () => {
    it("skipped — set E2E_DATABASE_URL, ANTHROPIC_API_KEY and E2B_API_KEY to run", () => {});
  });
} else {
  const mainPath = fileURLToPath(new URL("../src/main.ts", import.meta.url));
  const apiMainPath = fileURLToPath(new URL("../../api/src/main.ts", import.meta.url));
  const pool = new Pool({ connectionString: url, max: 5 });
  const store = createPgStore(drizzle({ client: pool }) as unknown as StoreDb);
  const sandboxes = createE2bProvider({ apiKey: e2bKey });

  // Short lease so the kill test's re-claim happens in seconds; the
  // heartbeat keeps live steps alive regardless of duration.
  const LEASE_MS = 3_000;

  const workers: ChildProcess[] = [];
  const sessions: SessionRef[] = [];

  beforeAll(async () => {
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await pool.query(storeDdl);
  });

  afterAll(async () => {
    for (const worker of workers) {
      if (worker.exitCode === null && worker.signalCode === null) worker.kill("SIGKILL");
    }
    // Orphan hygiene: kill the sandboxes the runs created.
    for (const sessionRef of sessions) {
      const session = await store.getSession(sessionRef);
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

  async function seedSession(task: string): Promise<SessionRef> {
    const agentConfigRef = await store.createAgentConfig({
      namespace: DEFAULT_NAMESPACE,
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
    const envConfigRef = await store.createEnvConfig({ namespace: DEFAULT_NAMESPACE });
    const sessionRef = await store.createSession({
      namespace: DEFAULT_NAMESPACE,
      agentConfigId: agentConfigRef.agentConfigId,
      envConfigId: envConfigRef.envConfigId,
    });
    sessions.push(sessionRef);
    const result = await store.intake(sessionRef, {
      role: "user",
      content: [{ type: "text", text: task }],
    });
    expect(result.kind).toBe("started");
    return sessionRef;
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
  async function runFinished(sessionRef: SessionRef): Promise<boolean> {
    const items = await store.listItems(sessionRef);
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
        const sessionRef = await seedSession(
          "Create a file at /home/user/hello.txt containing exactly: hello funky",
        );
        const worker = forkWorker();
        try {
          await waitFor(() => runFinished(sessionRef), 150_000, "the run to finish");
        } finally {
          // Claims have no session filter: a worker that outlives its test
          // would steal the next test's items.
          await killWorker(worker);
        }

        const entries = await store.readEntries(sessionRef);
        assertEveryCallResolvedOnce(entries);
        const msgs = messages(entries);
        const tail = msgs[msgs.length - 1];
        if (tail?.role !== "assistant") throw new Error("run did not end on an assistant message");
        expect(tail.stopReason).toBe("end_turn");
        expect(msgs.some((m) => m.role === "toolResult" && !m.isError)).toBe(true);

        // The workspace really changed: read the file back through the
        // provider, via the binding the driver registered.
        const session = await store.getSession(sessionRef);
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
        const sessionRef = await seedSession(
          "First run the bash command `sleep 15`. Then create a file at " +
            "/home/user/done.txt containing exactly: recovered",
        );
        // `first` is the only live worker (each test kills its own), so
        // the leased claim below is provably the one the SIGKILL lands on.
        const first = forkWorker();
        await waitFor(
          async () => {
            const items = await store.listItems(sessionRef);
            return items.some((item) => item.type === "execute_tools" && item.status === "leased");
          },
          120_000,
          "an execute_tools claim",
        );
        await killWorker(first);

        const resume = forkWorker();
        try {
          await waitFor(() => runFinished(sessionRef), 240_000, "the resumed run to finish");
        } finally {
          await killWorker(resume);
        }

        const entries = await store.readEntries(sessionRef);
        assertEveryCallResolvedOnce(entries);
        // The carve-out ran: the killed batch was re-claimed, not re-executed —
        // its calls settled as synthesized interrupted results.
        const items = await store.listItems(sessionRef);
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

  // --- stack e2e: the real api beside the real worker, HTTP-only ---

  const API_PORT = 3891;
  const API_URL = `http://127.0.0.1:${API_PORT}`;
  const API_TOKEN = "e2e-stack-bearer-0123456789abcdef";

  function forkApi(): ChildProcess {
    const api = fork(apiMainPath, [], {
      execArgv: ["--import", "tsx"],
      env: {
        ...process.env,
        DATABASE_URL: url,
        PORT: String(API_PORT),
        FUNKY_AUTH_TOKEN: API_TOKEN,
        FUNKY_STREAM_POLL_MS: "100",
      },
    });
    workers.push(api);
    return api;
  }

  async function apiJson(method: "GET" | "POST", path: string, body?: unknown): Promise<any> {
    const res = await fetch(`${API_URL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${API_TOKEN}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}`);
    return res.json();
  }

  /** Read the session's SSE stream until `until` holds over the entries
   *  received so far. `after` resumes via Last-Event-ID, exactly as a
   *  reconnecting EventSource would; heartbeat comments are skipped. */
  async function readStream(
    sessionId: string,
    opts: { after?: number; until: (entries: SessionEntry[]) => boolean; timeoutMs: number },
  ): Promise<SessionEntry[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
    const headers: Record<string, string> = { Authorization: `Bearer ${API_TOKEN}` };
    if (opts.after !== undefined) headers["Last-Event-ID"] = String(opts.after);
    const collected: SessionEntry[] = [];
    try {
      const res = await fetch(`${API_URL}/v1/sessions/${sessionId}/stream`, {
        headers,
        signal: controller.signal,
      });
      if (!res.ok || !res.body) throw new Error(`stream -> ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (!opts.until(collected)) {
        const { done, value } = await reader.read();
        if (done) throw new Error("stream ended before the condition was met");
        buffer += decoder.decode(value, { stream: true });
        let cut;
        while ((cut = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          const data = frame
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trim())
            .join("");
          if (data !== "") collected.push(JSON.parse(data) as SessionEntry);
        }
      }
      return collected;
    } catch (err) {
      if (controller.signal.aborted) {
        throw new Error(`timed out streaming after ${opts.timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
      // Hanging up is the stream's only end — the abort stops the route's loop.
      controller.abort();
    }
  }

  describe("stack e2e (two processes: the real api + the real worker)", () => {
    it(
      "seeds over HTTP, streams live, survives kill -9, reconnects with the cursor",
      { timeout: 300_000 },
      async () => {
        const api = forkApi();
        let first: ChildProcess | undefined;
        let resume: ChildProcess | undefined;
        try {
          await waitFor(
            async () => (await fetch(`${API_URL}/health`).catch(() => null))?.ok === true,
            30_000,
            "the api to come up",
          );

          // Seed exclusively over HTTP — the api is the only writer here.
          const agent = await apiJson("POST", "/v1/agent-configs", {
            namespace: DEFAULT_NAMESPACE,
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
          const env = await apiJson("POST", "/v1/env-configs", {
            namespace: DEFAULT_NAMESPACE,
          });
          const session = await apiJson("POST", "/v1/sessions", {
            agentConfigId: agent.id,
            envConfigId: env.id,
          });
          // The wire echoes namespace, so the response rebuilds the ref
          // (apiJson returns any — nothing checks this line but us).
          sessions.push({ namespace: session.namespace, sessionId: session.id });
          const started = await apiJson("POST", `/v1/sessions/${session.id}/messages`, {
            content:
              "First run the bash command `sleep 15`. Then create a file at " +
              "/home/user/answer.txt containing exactly: streamed",
          });
          expect(started.kind).toBe("started");

          // Watch the run open on the live stream: the replayed user
          // message, then the assistant's tool call landing in real time.
          first = forkWorker();
          const opening = await readStream(session.id, {
            until: (entries) => entries.length >= 2,
            timeoutMs: 120_000,
          });
          const lastSeen = opening[opening.length - 1]!.seq;

          // The sleep is the kill window (see the worker e2e kill test).
          await waitFor(
            async () => {
              const items = await apiJson("GET", `/v1/sessions/${session.id}/items`);
              return items.some(
                (item: { type: string; status: string }) =>
                  item.type === "execute_tools" && item.status === "leased",
              );
            },
            120_000,
            "an execute_tools claim",
          );
          await killWorker(first);
          resume = forkWorker();

          // Reconnect exactly as an EventSource would: Last-Event-ID is
          // the seq of the last entry seen before the disconnect.
          const rest = await readStream(session.id, {
            after: lastSeen,
            until: (entries) =>
              entries.some(
                (entry) =>
                  entry.type === "message" &&
                  entry.message.role === "assistant" &&
                  entry.message.stopReason === "end_turn",
              ),
            timeoutMs: 240_000,
          });

          await waitFor(
            async () => {
              const items = await apiJson("GET", `/v1/sessions/${session.id}/items`);
              return (
                items.length > 0 &&
                items.every((item: { status: string }) => item.status === "done")
              );
            },
            30_000,
            "all items done",
          );

          // Continuity across the reconnect: the two stream segments,
          // concatenated, are the durable log — no gap, no duplicate.
          const streamed = [...opening, ...rest].map((entry) => entry.seq);
          const durable = (await apiJson(
            "GET",
            `/v1/sessions/${session.id}/entries`,
          )) as SessionEntry[];
          expect(streamed).toEqual(durable.map((entry) => entry.seq).sort((a, b) => a - b));

          // The same invariants as the worker e2e, read over HTTP.
          assertEveryCallResolvedOnce(durable);
          const items = await apiJson("GET", `/v1/sessions/${session.id}/items`);
          expect(
            items.some(
              (item: { type: string; attempt: number }) =>
                item.type === "execute_tools" && item.attempt > 1,
            ),
          ).toBe(true);
          const msgs = messages(durable);
          expect(
            msgs.some(
              (m) =>
                m.role === "toolResult" &&
                m.isError &&
                m.content.some((part) => part.type === "text" && part.text.includes("interrupted")),
            ),
          ).toBe(true);

          // The workspace really changed, via the binding the wire reports.
          const bound = await apiJson("GET", `/v1/sessions/${session.id}`);
          if (!bound.sandboxId) throw new Error("no sandbox bound to the session");
          const sandbox = await sandboxes.connect(bound.sandboxId);
          const bytes = await sandbox.readFile("/home/user/answer.txt");
          expect(new TextDecoder().decode(bytes).trim()).toBe("streamed");
        } finally {
          if (first) await killWorker(first).catch(() => {});
          if (resume) await killWorker(resume);
          await killWorker(api); // SIGKILL is the api's shutdown story too
        }
      },
    );
  });
}
