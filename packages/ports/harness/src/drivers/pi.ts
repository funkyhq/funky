// packages/ports/harness/src/drivers/pi.ts — the pi harness driver.
//
// One runTurn = one AgentSession.prompt() — pi's agentic loop runs IN-PROCESS (the
// SDK is open TypeScript; there is no vendor subprocess). Confinement is therefore
// not tool denial but tool REPLACEMENT: pi's four default tools (read, bash, edit,
// write) are re-created over sandbox-backed *Operations — the SDK's own remote-
// execution seam — so the model keeps pi's native tool surface while every sandbox
// touch funnels through the journaled exec bridge: append the decision to the Funky
// log (the seq yields the idemKey), execute through the caller's exactly-once exec,
// append the result. Nothing the model does can reach the worker host.
//
// Statelessness: pi's SessionManager owns a local JSONL session file with no store
// adapter, so the driver owns the mirror instead — the file lives on per-attempt
// scratch, every FileEntry (header included) is flushed to Postgres behind the
// attempt fence (pi-store.ts), and resume materializes the file back from Postgres.
// Because flushes are driver-driven and awaited, a fence loss or mirror failure
// surfaces synchronously (no vendor "mirror_error" indirection): before the prompt,
// after every appended entry, and once more before the turn returns — a committed
// turn always sits on a gap-free transcript.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentSessionEvent,
  type BashOperations,
  createAgentSession,
  createBashToolDefinition,
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  DefaultResourceLoader,
  type EditOperations,
  ModelRuntime,
  type ReadOperations,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
  type WriteOperations,
} from "@earendil-works/pi-coding-agent";
import type { Db } from "@funky/db";
import { idemKeyFor, textContent, type ToolCall } from "@funky/sessions/events";
import {
  type ExecResult,
  HarnessFencedError,
  HarnessPermanentError,
  HarnessTransientError,
  type HarnessPort,
  type HarnessTurnRequest,
  type HarnessTurnResult,
} from "../port";
import { loadPiTranscript, type PiFileEntry, PiTranscriptStore } from "./pi-store";

/** The working directory pi believes it runs in. A sentinel, not a real path: pi
 *  resolves relative tool paths against it, and the sandbox ops translate paths
 *  under it back to relative form — which the sandbox resolves against its own
 *  workdir. Deterministic across the fleet by construction. */
export const SANDBOX_CWD = "/workspace";

/** funky provider name → pi-ai provider id, for the providers a worker can hold
 *  keys for. Anything absent here is a permanent config error. */
const PI_PROVIDERS = {
  anthropic: "anthropic",
  openai: "openai",
  togetherai: "together",
} as const;

export type PiProviderKeys = Partial<Record<keyof typeof PI_PROVIDERS, string>>;

const PI_TOOL_NAMES = ["read", "bash", "edit", "write"];

/** The slice of AgentSession the driver drives — the test seam's contract. */
export type PiSession = {
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;
  prompt(text: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
  readonly state: { readonly errorMessage?: string };
};

export type PiCreateSessionFn = (
  options: NonNullable<Parameters<typeof createAgentSession>[0]>,
) => Promise<{ session: PiSession }>;

export type PiHarnessOptions = {
  db: Db;
  /** Keys by FUNKY provider name; the driver maps to pi-ai provider ids. */
  apiKeys: PiProviderKeys;
  /** Parent dir for per-attempt scratch (pi session file, agent dir, auth). Point
   *  at RAM-backed storage in production; the contents are disposable by design. */
  scratchRoot?: string;
  /** Test seam: replaces the SDK's createAgentSession(). */
  createSessionFn?: PiCreateSessionFn;
};

export class PiHarness implements HarnessPort {
  private readonly db: Db;
  private readonly apiKeys: PiProviderKeys;
  private readonly scratchRoot: string;
  private readonly createSessionFn: PiCreateSessionFn;

  constructor(opts: PiHarnessOptions) {
    this.db = opts.db;
    this.apiKeys = opts.apiKeys;
    this.scratchRoot = opts.scratchRoot ?? join(tmpdir(), "funky-harness");
    this.createSessionFn = opts.createSessionFn ?? createAgentSession;
  }

  async runTurn(req: HarnessTurnRequest): Promise<HarnessTurnResult> {
    const provider = req.model.provider as keyof typeof PI_PROVIDERS;
    const piProvider = PI_PROVIDERS[provider];
    if (!piProvider) {
      throw new HarnessPermanentError(
        `pi harness does not support provider ${req.model.provider}`,
      );
    }
    const apiKey = this.apiKeys[provider];
    if (!apiKey) {
      throw new HarnessPermanentError(
        `pi harness has no API key for provider ${req.model.provider}`,
      );
    }

    // Per-attempt, disposable: pi's local session file, agent dir, and auth file
    // all live (and die) here. The durable trajectory is the fenced Postgres mirror.
    await mkdir(this.scratchRoot, { recursive: true });
    const scratch = await mkdtemp(join(this.scratchRoot, "pi-attempt-"));
    const agentDir = join(scratch, "agent");
    const sessionDir = join(scratch, "sessions");
    await mkdir(agentDir, { recursive: true });
    await mkdir(sessionDir, { recursive: true });

    const store = new PiTranscriptStore({
      db: this.db,
      namespace: req.namespace,
      funkySessionId: req.sessionId,
      attempt: req.attempt,
    });

    // Rehydrate the session file from Postgres (resume) or start fresh. The stored
    // rows ARE the file, header first — pi reopens it as if it never left disk.
    let sessionManager: SessionManager;
    if (req.resume) {
      const entries = await loadPiTranscript(this.db, req.namespace, req.sessionId, req.resume);
      if (entries.length === 0) {
        throw new HarnessTransientError(`no stored transcript for pi session ${req.resume}`);
      }
      store.preload(entries);
      const file = join(sessionDir, "session.jsonl");
      await writeFile(file, `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`);
      sessionManager = SessionManager.open(file, sessionDir);
    } else {
      sessionManager = SessionManager.create(SANDBOX_CWD, sessionDir);
    }
    const sdkSessionId = sessionManager.getSessionId();
    const fileEntries = (): PiFileEntry[] => {
      const header = sessionManager.getHeader();
      return [
        ...(header ? [header as unknown as PiFileEntry] : []),
        ...(sessionManager.getEntries() as unknown as PiFileEntry[]),
      ];
    };

    // First fatal error wins; everything after is the abort unwinding.
    const abortRef: { current: null | (() => void) } = { current: null };
    let fatal: unknown;
    const fail = (err: unknown): void => {
      fatal ??= err;
      abortRef.current?.();
    };

    // The appender may be called from concurrent tool executions and the message
    // observer; the port contract says the CALLER serializes, but a driver-side
    // chain costs nothing and makes the driver correct against a non-conforming
    // caller too.
    let appendChain: Promise<unknown> = Promise.resolve();
    const append = (e: Parameters<HarnessTurnRequest["append"]>[0]) => {
      const next = appendChain.then(() => req.append(e));
      appendChain = next.catch(() => {});
      return next;
    };

    // The exec bridge — every sandbox touch goes through here. Journal FIRST: the
    // decision enters the log before the sandbox sees it, and the seq it lands at
    // is the idemKey — the native loop's write-ahead discipline, verbatim.
    const journaledExec = async (cmd: string, timeoutMs?: number): Promise<ExecResult> => {
      try {
        const call: ToolCall =
          timeoutMs !== undefined
            ? { kind: "exec", cmd, timeout_ms: clampTimeoutMs(timeoutMs) }
            : { kind: "exec", cmd };
        const { seq } = await append({
          kind: "assistant_message",
          content: [],
          toolCalls: [call],
        });
        const idemKey = idemKeyFor(req.sessionId, seq, 0);
        const res = await req.exec(call, idemKey);
        await append({ kind: "tool_result", idemKey, ...res });
        return res;
      } catch (err) {
        // Conflict, fence loss, sandbox death. pi treats a throwing tool as a
        // FAILED TOOL RESULT and keeps looping — that must not happen for infra
        // errors, so abort the session before rethrowing.
        fail(err);
        throw err instanceof Error ? err : new Error(String(err));
      }
    };

    const ops = makeSandboxOps(journaledExec);
    const customTools = [
      createBashToolDefinition(SANDBOX_CWD, {
        operations: ops.bash,
        exposeSessionEnvironment: false,
      }),
      createReadToolDefinition(SANDBOX_CWD, { operations: ops.read, autoResizeImages: false }),
      createEditToolDefinition(SANDBOX_CWD, { operations: ops.edit }),
      createWriteToolDefinition(SANDBOX_CWD, { operations: ops.write }),
    ] as unknown as ToolDefinition[];

    // Model + auth: an isolated runtime whose only credential is this turn's key.
    // No network refresh, no host auth.json, no env fallback.
    const modelRuntime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
    });
    // setRuntimeApiKey registers the credential SYNCHRONOUSLY; the awaited tail is
    // only an availability refresh, which can stall for minutes on a hung provider
    // probe (observed live: a ~300s undici headers timeout). The driver never
    // consumes availability — the model is resolved from the catalog and streamed
    // directly — so cap the wait and move on; a late rejection is swallowed.
    const setKey = modelRuntime.setRuntimeApiKey(piProvider, apiKey);
    setKey.catch(() => {});
    await Promise.race([setKey, new Promise((r) => setTimeout(r, 15_000))]);
    const model = modelRuntime.getModel(piProvider, req.model.model);
    if (!model) {
      throw new HarnessPermanentError(
        `pi harness: unknown model ${req.model.model} for provider ${piProvider}`,
      );
    }

    // Full isolation from the host: no extensions, skills, prompt templates,
    // themes, or context files; the pinned agent version's prompt is the base
    // system prompt (pi appends its tool documentation to it).
    const settingsManager = SettingsManager.create(SANDBOX_CWD, agentDir);
    const resourceLoader = new DefaultResourceLoader({
      cwd: SANDBOX_CWD,
      agentDir,
      settingsManager,
      systemPrompt: req.systemPrompt,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await resourceLoader.reload();

    const { session } = await this.createSessionFn({
      cwd: SANDBOX_CWD,
      agentDir,
      modelRuntime,
      model,
      tools: PI_TOOL_NAMES,
      customTools,
      resourceLoader,
      sessionManager,
      settingsManager,
    });
    abortRef.current = () => void session.abort();

    // maxTurns budget: pi's loop has no cap of its own, so the driver counts
    // assistant turns and refuses to START one past the budget — a turn that
    // FINISHES exactly on budget is still a success.
    const maxTurns = req.limits.maxTurns;
    let assistantTurns = 0;
    let budgetStop = false;
    const usage = { inputTokens: 0, outputTokens: 0 };

    const flush = (): void => {
      void store.flush(sdkSessionId, fileEntries()).catch(fail);
    };

    const unsubscribe = session.subscribe((ev) => {
      if (ev.type === "entry_appended") {
        flush();
        return;
      }
      if (ev.type === "turn_start" && maxTurns !== undefined && assistantTurns >= maxTurns) {
        budgetStop = true;
        void session.abort();
        return;
      }
      if (ev.type === "message_end" && ev.message.role === "assistant") {
        assistantTurns += 1;
        const m = ev.message as {
          content?: Array<{ type: string; text?: string }>;
          usage?: { input?: number; output?: number };
        };
        usage.inputTokens += m.usage?.input ?? 0;
        usage.outputTokens += m.usage?.output ?? 0;
        // Project assistant TEXT into the log (thinking is not projected in v1;
        // tool-call decisions are journaled by the exec bridge instead).
        const text = (m.content ?? [])
          .filter((b) => b.type === "text")
          .map((b) => b.text ?? "")
          .join("");
        if (text.length > 0) {
          void append({
            kind: "assistant_message",
            content: textContent(text),
            toolCalls: [],
            ...(m.usage
              ? {
                  usage: {
                    inputTokens: m.usage.input ?? 0,
                    outputTokens: m.usage.output ?? 0,
                  },
                }
              : {}),
          }).catch(fail);
        }
      }
    });

    let errorMessage: string | undefined;
    try {
      // Durable before the model speaks: the initial entries land behind the fence,
      // so a fenced zombie dies HERE, before it can prompt.
      await store.flush(sdkSessionId, fileEntries());
        await session.prompt(req.prompt);
        errorMessage = session.state.errorMessage;
    } catch (err) {
      if (fatal === undefined) fatal = classify(err);
    } finally {
      unsubscribe();
      // Drain projected appends, then flush the transcript tail. Both are awaited:
      // returning while either is in flight would race the caller's commit.
      await appendChain;
      await store.flush(sdkSessionId, fileEntries()).catch((err) => {
        fatal ??= err;
      });
      session.dispose();
      await rm(scratch, { recursive: true, force: true }).catch(() => {});
    }

    if (fatal !== undefined) throw fatal;
    if (budgetStop) {
      return {
        sdkSessionId,
        usage,
        stop: { type: "budget", message: "harness max_turns exhausted" },
      };
    }
    if (errorMessage !== undefined) throw classify(new Error(`pi turn failed: ${errorMessage}`));
    return { sdkSessionId, usage, stop: { type: "success" } };
  }
}

// ---------------------------------------------------------------------------
// Sandbox-backed tool operations
// ---------------------------------------------------------------------------

/** Everything pi's read/bash/edit/write tools need, compiled to POSIX shell over
 *  the journaled exec bridge. Content crosses the exec channel base64-encoded
 *  (the channel is a combined text stream; base64 keeps bytes intact). Exported
 *  for direct unit testing. */
export function makeSandboxOps(runExec: (cmd: string, timeoutMs?: number) => Promise<ExecResult>): {
  bash: BashOperations;
  read: ReadOperations;
  edit: EditOperations;
  write: WriteOperations;
} {
  const readFile = async (absolutePath: string): Promise<Buffer> => {
    const res = await runExec(`base64 < ${sh(sbPath(absolutePath))}`);
    if (res.exitCode !== 0) {
      throw new Error(res.output.trim() || `read failed (exit ${res.exitCode}): ${absolutePath}`);
    }
    if (res.truncated) {
      throw new Error(`File too large to read through the sandbox exec channel: ${absolutePath}`);
    }
    return Buffer.from(res.output.replace(/\s+/g, ""), "base64");
  };
  const writeFileOp = async (absolutePath: string, content: string): Promise<void> => {
    // Single line ON PURPOSE: the sandbox executors wrap the command inline
    // (`(<cmd>) > out 2>&1; …`), which breaks a trailing heredoc terminator — the
    // shell then waits on stdin forever. printf is a shell builtin, so the payload
    // is not subject to execve argv limits.
    const b64 = Buffer.from(content, "utf8").toString("base64");
    const res = await runExec(`printf '%s' '${b64}' | base64 -d > ${sh(sbPath(absolutePath))}`);
    if (res.exitCode !== 0) {
      throw new Error(res.output.trim() || `write failed (exit ${res.exitCode}): ${absolutePath}`);
    }
  };
  const accessCheck = async (absolutePath: string, test: string, what: string): Promise<void> => {
    const res = await runExec(`${test} ${sh(sbPath(absolutePath))}`);
    if (res.exitCode !== 0) throw new Error(`File not ${what}: ${absolutePath}`);
  };

  return {
    bash: {
      // pi hands the tool's raw `timeout` (SECONDS) to custom operations; the cwd
      // argument is ignored — commands already run in the sandbox's own workdir,
      // which is what SANDBOX_CWD stands in for.
      exec: async (command, _cwd, { onData, timeout }) => {
        const res = await runExec(command, timeout !== undefined ? timeout * 1000 : undefined);
        if (res.output.length > 0) onData(Buffer.from(res.output, "utf8"));
        return { exitCode: res.exitCode };
      },
    },
    read: {
      readFile,
      access: (p) => accessCheck(p, "test -r", "readable"),
      // Text-only in v1: the exec channel would need binary-safe image plumbing.
      detectImageMimeType: async () => null,
    },
    edit: {
      readFile,
      writeFile: writeFileOp,
      access: (p) => accessCheck(p, "test -e", "accessible"),
    },
    write: {
      writeFile: writeFileOp,
      mkdir: async (dir) => {
        const res = await runExec(`mkdir -p ${sh(sbPath(dir))}`);
        if (res.exitCode !== 0) {
          throw new Error(res.output.trim() || `mkdir failed (exit ${res.exitCode}): ${dir}`);
        }
      },
    },
  };
}

/** Translate a pi-resolved absolute path to what the sandbox shell should see:
 *  paths under the SANDBOX_CWD fiction become relative (the sandbox resolves them
 *  against its real workdir); anything else passes through untouched. */
function sbPath(absolutePath: string): string {
  if (absolutePath === SANDBOX_CWD) return ".";
  if (absolutePath.startsWith(`${SANDBOX_CWD}/`)) return absolutePath.slice(SANDBOX_CWD.length + 1);
  return absolutePath;
}

/** Single-quote for POSIX sh. */
function sh(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

function clampTimeoutMs(ms: number): number {
  return Math.min(Math.max(Math.round(ms), 1), 600_000);
}

/** SDK/API failures outside our own fail() path. */
function classify(err: unknown): unknown {
  if (
    err instanceof HarnessTransientError ||
    err instanceof HarnessPermanentError ||
    err instanceof HarnessFencedError
  ) {
    return err;
  }
  const msg = err instanceof Error ? err.message : String(err);
  if (/api key|authentication|401|403/i.test(msg)) {
    return new HarnessPermanentError(`pi auth failure: ${msg}`);
  }
  return new HarnessTransientError(`pi failure: ${msg}`);
}
