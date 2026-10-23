import { describe, expect, it } from "vitest";
import {
  AgentConfig,
  AgentConfigRef,
  AgentConfigVersionRef,
  CreateAgentConfigRequest,
  CreateSessionRequest,
  IntakeResult,
  ListAgentConfigsRequest,
  ListSessionsRequest,
  PendingInput,
  Session,
  SessionRef,
  UpdateAgentConfigRequest,
  WorkItem,
  WorkItemRef,
} from "../src/store";

const roundTrip = <T>(schema: { parse: (v: unknown) => T }, value: unknown): T =>
  schema.parse(JSON.parse(JSON.stringify(value)));

describe("configs", () => {
  it("round-trips a stored agent config", () => {
    const config = {
      agentConfigId: "ac1",
      inference: {
        provider: "anthropic",
        model: "claude-sonnet-5",
        maxTokens: 8192,
        temperature: 0.7,
      },
      systemPrompt: "You are helpful.",
      network: { type: "allowlist", domains: ["pypi.org"] },
      packages: { pip: ["pandas==2.2.0"] },
      credentials: [
        {
          type: "injected",
          env: "STRIPE_API_KEY",
          secret: "stripe-live",
          domains: ["api.stripe.com"],
          header: "Authorization",
          value: "Bearer {secret}",
        },
        {
          type: "injected",
          env: "GH_TOKEN",
          secret: "github",
          domains: ["api.github.com"],
          header: "Authorization",
          value: "Bearer {secret}",
        },
      ],
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
      network: { type: "unrestricted" },
      packages: {},
      credentials: [],
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
    expect(AgentConfigRef.safeParse({ namespace: "tenant-a", agentConfigId: "ac1" }).success).toBe(
      true,
    );
    expect(AgentConfigRef.safeParse({ namespace: "tenant-a", agentConfigId: "" }).success).toBe(
      false,
    );
    expect(
      AgentConfigVersionRef.safeParse({ namespace: "tenant-a", agentConfigId: "ac1", version: 2 })
        .success,
    ).toBe(true);
    expect(
      AgentConfigVersionRef.safeParse({ namespace: "tenant-a", agentConfigId: "ac1", version: 0 })
        .success,
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
      agentConfigId: "ac1",
      inference: { provider: "fake", model: "scripted" },
      systemPrompt: "s",
      network: { type: "unrestricted" },
      packages: {},
      credentials: [],
      namespace: "default",
      version: 1,
      createdAt: "2026-08-11T12:00:00Z",
      updatedAt: "2026-08-11T12:00:00Z",
    };
    expect(roundTrip(AgentConfig, config)).toEqual(config);
  });

  it("rejects null sampling params — absence has exactly one spelling", () => {
    const result = AgentConfig.safeParse({
      agentConfigId: "ac1",
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

  it("requires the environment on a stored agent config", () => {
    const config = {
      agentConfigId: "ac1",
      inference: { provider: "fake", model: "scripted" },
      systemPrompt: "s",
      namespace: "default",
      version: 1,
      createdAt: "2026-08-11T12:00:00Z",
      updatedAt: "2026-08-11T12:00:00Z",
    };
    expect(AgentConfig.safeParse(config).success).toBe(false);
    expect(AgentConfig.safeParse({ ...config, network: { type: "none" } }).success).toBe(false);
    expect(
      AgentConfig.safeParse({ ...config, network: { type: "none" }, packages: {} }).success,
    ).toBe(false);
    expect(
      AgentConfig.safeParse({ ...config, network: { type: "none" }, packages: {}, credentials: [] })
        .success,
    ).toBe(true);
  });

  it("requires the environment on agent config create, accepts it on update, and validates it", () => {
    const create = {
      namespace: "default",
      inference: { provider: "fake", model: "scripted" },
      systemPrompt: "s",
      network: { type: "allowlist", domains: ["pypi.org"] },
      packages: { pip: ["numpy"] },
      credentials: [
        {
          type: "injected",
          env: "GH_TOKEN",
          secret: "github",
          domains: ["api.github.com"],
          header: "Authorization",
          value: "Bearer {secret}",
        },
      ],
    };
    expect(CreateAgentConfigRequest.safeParse(create).success).toBe(true);
    const { network, packages, credentials, ...bare } = create;
    expect(CreateAgentConfigRequest.safeParse({ ...bare, packages, credentials }).success).toBe(
      false,
    );
    expect(CreateAgentConfigRequest.safeParse({ ...bare, network, credentials }).success).toBe(
      false,
    );
    expect(CreateAgentConfigRequest.safeParse({ ...bare, network, packages }).success).toBe(false);
    expect(
      CreateAgentConfigRequest.safeParse({ ...create, credentials: [{ env: "GH_TOKEN" }] }).success,
    ).toBe(false);
    expect(
      CreateAgentConfigRequest.safeParse({ ...create, network: { type: "vpn" } }).success,
    ).toBe(false);
    expect(CreateAgentConfigRequest.safeParse({ ...create, packages: ["numpy"] }).success).toBe(
      false,
    );
    expect(UpdateAgentConfigRequest.safeParse({ network: { type: "none" } }).success).toBe(true);
    expect(UpdateAgentConfigRequest.safeParse({ credentials: [] }).success).toBe(true);
    expect(UpdateAgentConfigRequest.safeParse({ packages: ["numpy"] }).success).toBe(false);
    expect(UpdateAgentConfigRequest.safeParse({ credentials: {} }).success).toBe(false);
  });

  it("round-trips an archived agent config — the mark is a timestamp, not a flag", () => {
    const config = {
      agentConfigId: "ac1",
      inference: { provider: "fake", model: "scripted" },
      systemPrompt: "s",
      network: { type: "unrestricted" },
      packages: {},
      credentials: [],
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
      agentConfigId: "ac1",
      inference: { provider: "fake", model: "scripted" },
      systemPrompt: "s",
      network: { type: "unrestricted" },
      packages: {},
      credentials: [],
      namespace: "default",
      version: 1,
      createdAt: "2026-08-11T12:00:00Z",
      updatedAt: "2026-08-11T12:00:00Z",
    };
    expect(AgentConfig.safeParse(config).success).toBe(true);
    expect(AgentConfig.safeParse({ ...config, archivedAt: null }).success).toBe(false);
    expect(AgentConfig.safeParse({ ...config, archivedAt: true }).success).toBe(false);
  });
});

describe("sessions", () => {
  it("round-trips a stored session — no metadata means no metadata key", () => {
    const session = {
      namespace: "default",
      sessionId: "s1",
      agentConfigId: "ac1",
      agentConfigVersion: 2,
      createdAt: "2026-08-11T12:00:00Z",
    };
    expect(roundTrip(Session, session)).toEqual(session);
  });

  it("round-trips an archived session — the mark is a timestamp, not a flag", () => {
    const session = {
      namespace: "default",
      sessionId: "s1",
      agentConfigId: "ac1",
      agentConfigVersion: 2,
      createdAt: "2026-08-11T12:00:00Z",
      archivedAt: "2026-08-13T12:00:00Z",
    };
    expect(roundTrip(Session, session)).toEqual(session);
  });

  it("rejects null or boolean session archivedAt — active is spelled by absence", () => {
    const session = {
      namespace: "default",
      sessionId: "s1",
      agentConfigId: "ac1",
      agentConfigVersion: 1,
      createdAt: "2026-08-11T12:00:00Z",
    };
    expect(Session.safeParse({ ...session, archivedAt: null }).success).toBe(false);
    expect(Session.safeParse({ ...session, archivedAt: true }).success).toBe(false);
  });

  it("rejects a stored session missing namespace — the row is its own ref", () => {
    const result = Session.safeParse({
      sessionId: "s1",
      agentConfigId: "ac1",
      agentConfigVersion: 1,
      createdAt: "2026-08-11T12:00:00Z",
    });
    expect(result.success).toBe(false);
  });

  it("validates namespace-scoped session references", () => {
    expect(SessionRef.safeParse({ namespace: "tenant-a", sessionId: "s1" }).success).toBe(true);
    expect(SessionRef.safeParse({ namespace: "tenant-a", sessionId: "" }).success).toBe(false);
    expect(SessionRef.safeParse({ namespace: "", sessionId: "s1" }).success).toBe(false);
  });

  it("validates session pagination's archived opt-in", () => {
    expect(
      ListSessionsRequest.safeParse({
        namespace: "tenant-a",
        limit: 10,
        after: "s1",
        includeArchived: true,
      }).success,
    ).toBe(true);
    expect(
      ListSessionsRequest.safeParse({
        namespace: "tenant-a",
        limit: 10,
        includeArchived: "true",
      }).success,
    ).toBe(false);
  });

  it("requires an explicit namespace when creating a session", () => {
    expect(CreateSessionRequest.safeParse({ agentConfigId: "ac1" }).success).toBe(false);
  });

  it("rejects a create request without an agent config id", () => {
    const result = CreateSessionRequest.safeParse({ namespace: "default" });
    expect(result.success).toBe(false);
  });

  it("accepts a create request that names only the agent config — it carries the sandbox", () => {
    const result = CreateSessionRequest.safeParse({ namespace: "default", agentConfigId: "ac1" });
    expect(result.success).toBe(true);
  });

  it("accepts an optional positive agent config version", () => {
    expect(
      CreateSessionRequest.safeParse({
        namespace: "default",
        agentConfigId: "ac1",
        agentConfigVersion: 2,
      }).success,
    ).toBe(true);
    expect(
      CreateSessionRequest.safeParse({
        namespace: "default",
        agentConfigId: "ac1",
        agentConfigVersion: 0,
      }).success,
    ).toBe(false);
  });
});

describe("work items", () => {
  it("round-trips a work item — the row is its own ref", () => {
    const item = {
      namespace: "default",
      sessionId: "s1",
      itemId: "i1",
      type: "inference",
      status: "ready",
      attempt: 0,
    };
    expect(roundTrip(WorkItem, item)).toEqual(item);
  });

  it("validates the full-path work item reference", () => {
    expect(
      WorkItemRef.safeParse({ namespace: "tenant-a", sessionId: "s1", itemId: "i1" }).success,
    ).toBe(true);
    // The parent session is part of the address, not an optional detail.
    expect(WorkItemRef.safeParse({ namespace: "tenant-a", itemId: "i1" }).success).toBe(false);
  });

  it("rejects an unknown item type", () => {
    const result = WorkItem.safeParse({
      namespace: "default",
      sessionId: "s1",
      itemId: "i1",
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
