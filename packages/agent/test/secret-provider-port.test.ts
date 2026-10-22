import { describe, expect, it } from "vitest";
import { SecretNotFoundError } from "../src";

describe("SecretProvider port errors", () => {
  it("names the namespace and every missing secret", () => {
    expect(new SecretNotFoundError("tenant-a", ["stripe-live", "pg-password"])).toMatchObject({
      name: "SecretNotFoundError",
      namespace: "tenant-a",
      names: ["stripe-live", "pg-password"],
      message: "secrets not found in namespace tenant-a: stripe-live, pg-password",
    });
  });
});
