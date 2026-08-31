import { describe, expect, it } from "vitest";
import { ArchivedError } from "../src";

describe("Store port errors", () => {
  it("identifies the namespace and kind of config that is archived", () => {
    expect(new ArchivedError({ namespace: "tenant-a", agentConfigId: "ac1" })).toMatchObject({
      name: "ArchivedError",
      namespace: "tenant-a",
      configId: "ac1",
      configKind: "agent",
      message: "agent config tenant-a/ac1 is archived",
    });
    expect(new ArchivedError({ namespace: "tenant-b", envConfigId: "ec1" })).toMatchObject({
      name: "ArchivedError",
      namespace: "tenant-b",
      configId: "ec1",
      configKind: "env",
      message: "env config tenant-b/ec1 is archived",
    });
  });
});
