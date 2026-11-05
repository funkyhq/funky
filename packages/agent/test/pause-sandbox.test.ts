// pauseSessionSandbox over fakes: pause the bound sandbox by id, skip a
// session that never bound one, treat a sandbox already gone as nothing
// to do, and let every other failure through for the host to log.

import { describe, expect, test } from "vitest";
import type { Session, SessionRef } from "@funky/core";
import { pauseSessionSandbox } from "../src/driver/pause-sandbox";
import { SandboxNotFoundError } from "../src/ports/sandbox-provider";

const s1: SessionRef = { namespace: "default", sessionId: "s1" };

function fakeStore(sandboxId?: string) {
  const session: Session = {
    sessionId: "s1",
    agentConfigId: "a1",
    agentConfigVersion: 1,
    namespace: "default",
    createdAt: "2026-11-04T00:00:00.000Z",
    ...(sandboxId ? { sandboxId } : {}),
  };
  return { getSession: async () => session };
}

function fakeProvider(error?: Error) {
  const paused: string[] = [];
  return {
    paused,
    provider: {
      pause: async (sandboxId: string) => {
        paused.push(sandboxId);
        if (error) throw error;
      },
    },
  };
}

describe("pauseSessionSandbox", () => {
  test("pauses the session's bound sandbox by id", async () => {
    const { provider, paused } = fakeProvider();
    await pauseSessionSandbox(fakeStore("sbx_1"), provider, s1);
    expect(paused).toEqual(["sbx_1"]);
  });

  test("does nothing for a session that never bound a sandbox", async () => {
    const { provider, paused } = fakeProvider();
    await pauseSessionSandbox(fakeStore(), provider, s1);
    expect(paused).toEqual([]);
  });

  test("does nothing for an unknown session", async () => {
    const { provider, paused } = fakeProvider();
    await pauseSessionSandbox({ getSession: async () => undefined }, provider, s1);
    expect(paused).toEqual([]);
  });

  test("a sandbox already gone needs no pause", async () => {
    const { provider } = fakeProvider(new SandboxNotFoundError("sbx_1 not found"));
    await expect(pauseSessionSandbox(fakeStore("sbx_1"), provider, s1)).resolves.toBeUndefined();
  });

  test("any other failure propagates", async () => {
    const { provider } = fakeProvider(new Error("fetch failed"));
    await expect(pauseSessionSandbox(fakeStore("sbx_1"), provider, s1)).rejects.toThrow(
      "fetch failed",
    );
  });
});
