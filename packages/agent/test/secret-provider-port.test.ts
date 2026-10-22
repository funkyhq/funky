import { describe, expect, it } from "vitest";
import { SecretNotFoundError, secretValueProblem } from "../src";

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

describe("secretValueProblem", () => {
  it("passes values that keep both rules, inner whitespace and lone $ included", () => {
    for (const value of [
      "sk_live_1",
      "Bearer sk-ünïcödé ✓",
      "-----BEGIN KEY-----\nAAAA\n-----END KEY-----",
      "$OTHER {{OTHER}} $ {",
      "",
    ]) {
      expect(secretValueProblem(value)).toBeUndefined();
    }
  });

  it("names the rule a value breaks", () => {
    for (const value of [" sk", "sk ", "sk\n", "\tsk", "sk "]) {
      expect(secretValueProblem(value)).toBe("has whitespace at an end");
    }
    expect(secretValueProblem("prefix ${OTHER} suffix")).toBe("contains ${");
    expect(secretValueProblem("pa${ss")).toBe("contains ${");
  });
});
