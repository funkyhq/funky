// The vendor table and the registry built from it. No network: an entry
// is checked by what it wires and what it is handed, never by a call.
import { describe, expect, it, vi } from "vitest";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createTogetherAI } from "@ai-sdk/togetherai";
import { VENDORS, wireProviders } from "../src/providers";

vi.mock("@ai-sdk/anthropic", () => ({ createAnthropic: vi.fn(() => () => "anthropic-model") }));
vi.mock("@ai-sdk/google", () => ({
  createGoogleGenerativeAI: vi.fn(() => () => "google-model"),
}));
vi.mock("@ai-sdk/openai", () => ({ createOpenAI: vi.fn(() => () => "openai-model") }));
vi.mock("@ai-sdk/togetherai", () => ({ createTogetherAI: vi.fn(() => () => "together-model") }));

const ALL_KEYS = new Map([
  ["anthropic", "k-anthropic"],
  ["openai", "k-openai"],
  ["google", "k-google"],
  ["togetherai", "k-together"],
]);

describe("VENDORS", () => {
  it("names each vendor and env var once", () => {
    const ids = VENDORS.map((vendor) => vendor.id);
    const envKeys = VENDORS.map((vendor) => vendor.envKey);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(envKeys).size).toBe(envKeys.length);
  });
});

describe("wireProviders", () => {
  it("wires one adapter per key, under the vendor's id", () => {
    const providers = wireProviders(ALL_KEYS);
    expect([...providers.keys()].sort()).toEqual(["anthropic", "google", "openai", "togetherai"]);
    for (const provider of providers.values()) expect(typeof provider.stream).toBe("function");
  });

  it("hands each vendor its own key, explicitly", () => {
    wireProviders(ALL_KEYS);
    expect(createAnthropic).toHaveBeenCalledWith({ apiKey: "k-anthropic" });
    expect(createOpenAI).toHaveBeenCalledWith({ apiKey: "k-openai" });
    expect(createGoogleGenerativeAI).toHaveBeenCalledWith({ apiKey: "k-google" });
    expect(createTogetherAI).toHaveBeenCalledWith({ apiKey: "k-together" });
  });

  it("wires nothing for a vendor without a key, and nothing for an id off the table", () => {
    expect([...wireProviders(new Map([["openai", "k-openai"]])).keys()]).toEqual(["openai"]);
    expect(wireProviders(new Map([["nope", "k"]])).size).toBe(0);
    expect(wireProviders(new Map()).size).toBe(0);
  });
});
