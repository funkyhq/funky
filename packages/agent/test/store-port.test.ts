import { describe, expect, it } from "vitest";
import { ArchivedError, SessionNotIdleError } from "../src";

describe("Store port errors", () => {
  it("identifies the namespace and kind of config that is archived", () => {
    expect(
      ArchivedError.forAgentConfig({ namespace: "tenant-a", agentConfigId: "ac1" }),
    ).toMatchObject({
      name: "ArchivedError",
      namespace: "tenant-a",
      resourceId: "ac1",
      resourceKind: "agent",
      message: "agent config tenant-a/ac1 is archived",
    });
    expect(ArchivedError.forEnvConfig({ namespace: "tenant-b", envConfigId: "ec1" })).toMatchObject(
      {
        name: "ArchivedError",
        namespace: "tenant-b",
        resourceId: "ec1",
        resourceKind: "env",
        message: "env config tenant-b/ec1 is archived",
      },
    );
  });

  it("identifies terminal and running session conflicts", () => {
    expect(ArchivedError.forSession({ namespace: "tenant-a", sessionId: "s1" })).toMatchObject({
      name: "ArchivedError",
      namespace: "tenant-a",
      resourceId: "s1",
      resourceKind: "session",
      message: "session tenant-a/s1 is archived",
    });
    expect(new SessionNotIdleError({ namespace: "tenant-b", sessionId: "s2" })).toMatchObject({
      name: "SessionNotIdleError",
      namespace: "tenant-b",
      sessionId: "s2",
      message: "session tenant-b/s2 is not idle",
    });
  });
});
