// packages/sessions/src/exec.test.ts — the single-retry policy, against pure fakes.
//
// makeExec's contract: a TRANSIENT unavailability earns exactly one reconnect-and-retry
// by the same idemKey; a GONE sandbox propagates untouched (only turn.ts may decide what
// a permanent loss means); everything else passes through. No Postgres, no sandbox.

import { describe, expect, it } from "vitest";
import {
  type ExecEvent,
  type Executor,
  type SandboxDriver,
  SandboxGoneError,
  SandboxUnavailableError,
  SandboxUnreachableError,
} from "@funky/sandbox";
import { makeExec } from "./exec";
import type { ToolCall } from "./events";

const call: ToolCall = { kind: "exec", cmd: "echo hi" };
const handle = { driver: "fake" };

/** A driver whose connect() returns the next scripted executor; records every idemKey. */
function scriptedDriver(executors: Executor[]): { driver: SandboxDriver; connects: () => number } {
  let connects = 0;
  const driver: SandboxDriver = {
    async provision() {
      throw new Error("provision is not under test");
    },
    async teardown() {},
    connect() {
      const ex = executors[connects];
      connects += 1;
      if (!ex) throw new Error("connect called more times than scripted");
      return ex;
    },
  };
  return { driver, connects: () => connects };
}

function succeeding(seen: string[]): Executor {
  return {
    exec: (req) =>
      (async function* (): AsyncGenerator<ExecEvent> {
        seen.push(req.idemKey);
        yield { kind: "stdout", data: "hi\n" };
        yield { kind: "exit", code: 0, truncated: false };
      })(),
    attach: () => {
      throw new Error("attach is not under test");
    },
    async readFile() {
      throw new Error("readFile is not under test");
    },
    async writeFile() {},
  };
}

function throwing(err: Error): Executor {
  return {
    exec: () =>
      (async function* (): AsyncGenerator<ExecEvent> {
        throw err;
      })(),
    attach: () => {
      throw new Error("attach is not under test");
    },
    async readFile() {
      throw new Error("readFile is not under test");
    },
    async writeFile() {},
  };
}

describe("makeExec", () => {
  it("a transient unavailability reconnects once and retries the SAME idemKey", async () => {
    const seen: string[] = [];
    const { driver, connects } = scriptedDriver([
      throwing(new SandboxUnreachableError("blip")),
      succeeding(seen),
    ]);
    const exec = makeExec({ sandbox: driver, handle });
    const res = await exec(call, "k1");
    expect(res).toEqual({ output: "hi\n", exitCode: 0, truncated: false });
    expect(connects()).toBe(2);
    expect(seen).toEqual(["k1"]); // the retry rode the same idemKey
  });

  it("a stream that ends without an exit event counts as transient and retries", async () => {
    const seen: string[] = [];
    const truncatedStream: Executor = {
      ...succeeding([]),
      exec: () =>
        (async function* (): AsyncGenerator<ExecEvent> {
          yield { kind: "stdout", data: "partial" }; // no exit event → unobservable
        })(),
    };
    const { driver, connects } = scriptedDriver([truncatedStream, succeeding(seen)]);
    const exec = makeExec({ sandbox: driver, handle });
    const res = await exec(call, "k2");
    expect(res.exitCode).toBe(0);
    expect(connects()).toBe(2);
  });

  it("a GONE sandbox propagates immediately — no reconnect, no retry", async () => {
    const { driver, connects } = scriptedDriver([throwing(new SandboxGoneError("destroyed"))]);
    const exec = makeExec({ sandbox: driver, handle });
    await expect(exec(call, "k3")).rejects.toBeInstanceOf(SandboxGoneError);
    expect(connects()).toBe(1);
  });

  it("a second transient failure propagates to the caller's policy", async () => {
    const { driver, connects } = scriptedDriver([
      throwing(new SandboxUnreachableError("blip 1")),
      throwing(new SandboxUnreachableError("blip 2")),
    ]);
    const exec = makeExec({ sandbox: driver, handle });
    await expect(exec(call, "k4")).rejects.toBeInstanceOf(SandboxUnreachableError);
    expect(connects()).toBe(2);
  });

  it("a non-sandbox error passes through without a retry", async () => {
    const { driver, connects } = scriptedDriver([throwing(new Error("bug in the driver"))]);
    const exec = makeExec({ sandbox: driver, handle });
    await expect(exec(call, "k5")).rejects.toThrow("bug in the driver");
    expect(connects()).toBe(1);
  });

  it("no sandbox handle → SandboxUnavailableError before any connect", async () => {
    const { driver, connects } = scriptedDriver([]);
    const exec = makeExec({ sandbox: driver, handle: null });
    await expect(exec(call, "k6")).rejects.toBeInstanceOf(SandboxUnavailableError);
    expect(connects()).toBe(0);
  });
});
