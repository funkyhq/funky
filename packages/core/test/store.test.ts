import { describe, expect, it } from "vitest";
import {
  AgentConfig,
  AgentConfigRef,
  AgentConfigVersionRef,
  CreateAgentConfigRequest,
  CreateEnvConfigRequest,
  CreateSessionRequest,
  EnvConfig,
  EnvConfigRef,
  IntakeResult,
  ListAgentConfigsRequest,
  ListEnvConfigsRequest,
  PendingInput,
  Session,
  UpdateAgentConfigRequest,
  UpdateEnvConfigRequest,
  WorkItem,
} from "../src/store";

const roundTrip = <T>(schema: { parse: (v: unknown) => T }, value: unknown): T =>
  schema.parse(JSON.parse(JSON.stringify(value)));

describe("configs", () => {
  it("round-trips a stored agent config", () => {
    const config = {
      id: "ac1",
      inference: {
        provider: "anthropic",
        model: "claude-sonnet-5",
        maxTokens: 8192,
        temperature: 0.7,
      },
      systemPrompt: "You are helpful.",
      namespace: "tenant-a",
      metadata: { team: "growth" },
      version: 3,
      createdAt: "2026-08-11T12:00:00Z",
      updatedAt: "2026-08-12T12:00:00Z",
    };
    expect(roundTrip(AgentConfig, config)).toEqual(config);
  });

  it("accepts a create request without metadata or sampling params — absence needs no placeholder", () => {
    const result = CreateAgentConfigRequest.safeParse({
      namespace: "default",
      inference: { provider: "fake", model: "scripted" },
      systemPrompt: "s",
    });
    expect(result.success).toBe(true);
  });

  it("requires an explicit namespace when creating an agent config", () => {
    expect(
      CreateAgentConfigRequest.safeParse({
        inference: { provider: "fake", model: "scripted" },
        systemPrompt: "s",
      }).success,
    ).toBe(false);
  });

  it("validates current and versioned agent config references", () => {
    expect(AgentConfigRef.safeParse({ namespace: "tenant-a", id: "ac1" }).success).toBe(true);
    expect(AgentConfigRef.safeParse({ namespace: "tenant-a", id: "" }).success).toBe(false);
    expect(
      AgentConfigVersionRef.safeParse({ namespace: "tenant-a", id: "ac1", version: 2 }).success,
    ).toBe(true);
    expect(
      AgentConfigVersionRef.safeParse({ namespace: "tenant-a", id: "ac1", version: 0 }).success,
    ).toBe(false);
  });

  it("validates namespaced agent config pagination", () => {
    expect(
      ListAgentConfigsRequest.safeParse({ namespace: "tenant-a", limit: 10, after: "ac1" }).success,
    ).toBe(true);
    expect(ListAgentConfigsRequest.safeParse({ namespace: "", limit: 10 }).success).toBe(false);
    expect(ListAgentConfigsRequest.safeParse({ namespace: "tenant-a", limit: 0 }).success).toBe(
      false,
    );
  });

  it("round-trips a stored agent config with no sampling overrides — absence is the stored form", () => {
    const config = {
      id: "ac1",
      inference: { provider: "fake", model: "scripted" },
      systemPrompt: "s",
      namespace: "default",
      version: 1,
      createdAt: "2026-08-11T12:00:00Z",
      updatedAt: "2026-08-11T12:00:00Z",
    };
    expect(roundTrip(AgentConfig, config)).toEqual(config);
  });

  it("rejects null sampling params — absence has exactly one spelling", () => {
    const result = AgentConfig.safeParse({
      id: "ac1",
      inference: { provider: "anthropic", model: "m", maxTokens: null, temperature: null },
      systemPrompt: "s",
      createdAt: "2026-08-11T12:00:00Z",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a bare-string inference config — it must say which provider serves the model", () => {
    const result = CreateAgentConfigRequest.safeParse({
      namespace: "default",
      inference: "claude-sonnet-5",
      systemPrompt: "s",
    });
    expect(result.success).toBe(false);
  });

  it("accepts a partial update and an optional positive version precondition", () => {
    expect(UpdateAgentConfigRequest.safeParse({ systemPrompt: "new", version: 2 }).success).toBe(
      true,
    );
    expect(UpdateAgentConfigRequest.safeParse({}).success).toBe(true);
  });

  it("rejects an invalid update version or inference config", () => {
    expect(UpdateAgentConfigRequest.safeParse({ version: 0 }).success).toBe(false);
    expect(UpdateAgentConfigRequest.safeParse({ inference: "model-only" }).success).toBe(false);
  });

  it("round-trips an archived agent config — the mark is a timestamp, not a flag", () => {
    const config = {
      id: "ac1",
      inference: { provider: "fake", model: "scripted" },
      systemPrompt: "s",
      namespace: "default",
      version: 2,
      createdAt: "2026-08-11T12:00:00Z",
      updatedAt: "2026-08-12T12:00:00Z",
      archivedAt: "2026-08-13T12:00:00Z",
    };
    expect(roundTrip(AgentConfig, config)).toEqual(config);
  });

  it("rejects a null or boolean archivedAt — absence is spelled by absence", () => {
    const config = {
      id: "ac1",
      inference: { provider: "fake", model: "scripted" },
      systemPrompt: "s",
      namespace: "default",
      version: 1,
      createdAt: "2026-08-11T12:00:00Z",
      updatedAt: "2026-08-11T12:00:00Z",
    };
    expect(AgentConfig.safeParse({ ...config, archivedAt: null }).success).toBe(false);
    expect(AgentConfig.safeParse({ ...config, archivedAt: true }).success).toBe(false);
  });
});

describe("env configs", () => {
  it("round-trips a stored env config with the full recipe spine", () => {
    const config = {
      id: "ec1",
      network: { type: "allowlist", domains: ["api.anthropic.com", "pypi.org"] },
      packages: { pip: ["pandas==2.2.0", "numpy"], npm: ["express@4.18.0"] },
      namespace: "tenant-a",
      metadata: { envId: "env_014588" },
      createdAt: "2026-08-11T12:00:00Z",
    };
    expect(roundTrip(EnvConfig, config)).toEqual(config);
  });

  it("rejects a flat package list — specs are keyed by their package manager", () => {
    const result = CreateEnvConfigRequest.safeParse({
      namespace: "tenant-a",
      packages: ["numpy", "pandas"],
    });
    expect(result.success).toBe(false);
  });

  it("accepts a create request without recipe overrides — they resolve at create", () => {
    const result = CreateEnvConfigRequest.safeParse({ namespace: "tenant-a" });
    expect(result.success).toBe(true);
  });

  it("requires an explicit namespace when creating an env config", () => {
    expect(CreateEnvConfigRequest.safeParse({}).success).toBe(false);
  });

  it("validates namespace-scoped env config references", () => {
    expect(EnvConfigRef.safeParse({ namespace: "tenant-a", id: "ec1" }).success).toBe(true);
    expect(EnvConfigRef.safeParse({ namespace: "tenant-a", id: "" }).success).toBe(false);
    expect(EnvConfigRef.safeParse({ namespace: "", id: "ec1" }).success).toBe(false);
  });

  it("validates namespaced env config pagination", () => {
    expect(
      ListEnvConfigsRequest.safeParse({ namespace: "tenant-a", limit: 10, after: "ec1" }).success,
    ).toBe(true);
    expect(ListEnvConfigsRequest.safeParse({ namespace: "", limit: 10 }).success).toBe(false);
    expect(ListEnvConfigsRequest.safeParse({ namespace: "tenant-a", limit: 0 }).success).toBe(
      false,
    );
  });

  it("accepts partial and empty in-place env config updates", () => {
    expect(
      UpdateEnvConfigRequest.safeParse({
        network: { type: "none" },
        packages: { pip: ["numpy"] },
        metadata: { revision: 2 },
      }).success,
    ).toBe(true);
    expect(UpdateEnvConfigRequest.safeParse({ packages: {} }).success).toBe(true);
    expect(UpdateEnvConfigRequest.safeParse({}).success).toBe(true);
  });

  it("rejects malformed env config updates", () => {
    expect(UpdateEnvConfigRequest.safeParse({ network: { type: "vpn" } }).success).toBe(false);
    expect(UpdateEnvConfigRequest.safeParse({ packages: ["numpy"] }).success).toBe(false);
  });

  it("rejects an unknown network policy type", () => {
    const result = CreateEnvConfigRequest.safeParse({
      namespace: "tenant-a",
      network: { type: "vpn" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a stored env config missing network — materialized decisions must be present", () => {
    const result = EnvConfig.safeParse({
      id: "ec1",
      namespace: "tenant-a",
      packages: {},
      createdAt: "2026-08-11T12:00:00Z",
    });
    expect(result.success).toBe(false);
  });
});

describe("sessions", () => {
  it("round-trips a stored session — no metadata means no metadata key", () => {
    const session = {
      id: "s1",
      agentConfigId: "ac1",
      agentConfigVersion: 2,
      envConfigId: "ec1",
      namespace: "default",
      createdAt: "2026-08-11T12:00:00Z",
    };
    expect(roundTrip(Session, session)).toEqual(session);
  });

  it("rejects a stored session missing namespace — materialized decisions must be present", () => {
    const result = Session.safeParse({
      id: "s1",
      agentConfigId: "ac1",
      agentConfigVersion: 1,
      envConfigId: "ec1",
      createdAt: "2026-08-11T12:00:00Z",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a create request without an agent config id", () => {
    const result = CreateSessionRequest.safeParse({ envConfigId: "ec1" });
    expect(result.success).toBe(false);
  });

  it("rejects a create request without an env config id — every session names its world", () => {
    const result = CreateSessionRequest.safeParse({ agentConfigId: "ac1" });
    expect(result.success).toBe(false);
  });

  it("accepts an optional positive agent config version", () => {
    expect(
      CreateSessionRequest.safeParse({
        agentConfigId: "ac1",
        agentConfigVersion: 2,
        envConfigId: "ec1",
      }).success,
    ).toBe(true);
    expect(
      CreateSessionRequest.safeParse({
        agentConfigId: "ac1",
        agentConfigVersion: 0,
        envConfigId: "ec1",
      }).success,
    ).toBe(false);
  });
});

describe("work items", () => {
  it("round-trips a work item", () => {
    const item = { id: "i1", sessionId: "s1", type: "inference", status: "ready", attempt: 0 };
    expect(roundTrip(WorkItem, item)).toEqual(item);
  });

  it("rejects an unknown item type", () => {
    const result = WorkItem.safeParse({
      id: "i1",
      sessionId: "s1",
      type: "provision",
      status: "ready",
    });
    expect(result.success).toBe(false);
  });
});

describe("pending inputs", () => {
  it("round-trips a pending input wrapping a user message", () => {
    const input = {
      id: "p1",
      sessionId: "s1",
      message: { role: "user", content: [{ type: "text", text: "also check the tests" }] },
      arrivedAt: "2026-08-11T12:00:00Z",
    };
    expect(roundTrip(PendingInput, input)).toEqual(input);
  });

  it("rejects a pending input carrying a non-user message", () => {
    const result = PendingInput.safeParse({
      id: "p1",
      sessionId: "s1",
      message: { role: "assistant", content: [], model: "m", stopReason: "end_turn" },
      arrivedAt: "2026-08-11T12:00:00Z",
    });
    expect(result.success).toBe(false);
  });
});

describe("intake results", () => {
  it("round-trips both branches", () => {
    const started = { kind: "started", itemId: "i1" };
    const queued = { kind: "queued", inputId: "p1" };
    expect(roundTrip(IntakeResult, started)).toEqual(started);
    expect(roundTrip(IntakeResult, queued)).toEqual(queued);
  });

  it("rejects an unknown kind", () => {
    const result = IntakeResult.safeParse({ kind: "rejected", reason: "quota" });
    expect(result.success).toBe(false);
  });
});
