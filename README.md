# Funky

> An open protocol for cloud-native AI agents: pluggable **sandboxes**, **session stores**, and **runtimes** behind one contract.

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)

**Funky** defines a small, open contract for running AI agents in the cloud. Bring your own sandbox, your own session storage, and your own agent runtime. Funky is the seam that holds them together so none of them can lock you in.

It takes its cues from managed agent platforms, like Anthropic's managed agents, where the provider runs the whole loop for you: *create an agent, give it an environment, open a session, send it events.* Funky keeps that developer experience but makes every moving part swappable and self-hostable.

## Why Funky

Managed agent platforms are great until you need to:

- keep conversation history in your database, under your retention and compliance rules,
- swap the model or the agent loop itself,
- or simply not be tied to a single vendor's API.

Funky factors a cloud agent into **four small interfaces**. Implement, or pick, one of each, and you get the managed-agent developer experience on infrastructure you control. No vendor lock-in, maximum flexibility.

## Core concepts

| Concept | Description |
|---|---|
| **Agent** | The model, system prompt, tools, and skills. |
| **Environment** | Configuration for where sessions run: your own sandbox or a sandbox from some vendor. |
| **Session** | A running agent instance within an environment, performing a specific task and generating outputs. |
| **Events** | Messages exchanged between your application and the agent (user turns, tool results, status updates). |

## Architecture

<!-- TODO: paste architecture diagram here -->

Funky is built from four small interfaces, plus a thin **Client** that wires them together:

- **ConfigRegistry** stores and retrieves agent and environment configs.
- **SessionStore** creates sessions and appends/reads their item history.
- **SandboxRuntime** creates, executes in, and destroys sandboxes.
- **AgentService** runs a single turn of the agent loop against a sandbox.
- **Client** is the orchestrator developers actually call; it resolves ids → configs and coordinates the four services.

Each is an interface. Funky doesn't care whether your `SandboxRuntime` is backed by Docker, Firecracker, gVisor, or a remote provider, only that it satisfies the contract.

## How it works

1. **Create an agent.** Define the model, system prompt, tools, and skills. Create the agent once and reference it by ID across sessions.
2. **Create an environment.** Configure where the agent runs: a cloud sandbox, or a self-hosted sandbox on your own infrastructure.
3. **Start a session.** Launch a session that references your agent and environment configuration.
4. **Send events and stream responses.** Send user messages as events. The agent autonomously executes tools and streams back results through server-sent events (SSE). Event history is persisted server-side and can be fetched in full.

## Pluggable by design

Every contract is an interface, so each layer is independently swappable. These are *examples of the kinds of backends that fit each contract*, not a list of shipped integrations.

| Contract | Backends that fit the shape |
|---|---|
| **SandboxRuntime** | Local Docker, Firecracker, gVisor, Kubernetes Jobs, or a remote sandbox provider |
| **SessionStore** | In-memory, SQLite, Postgres, Redis, or object storage |
| **ConfigRegistry** | In-memory, Postgres, file-based, or Git-backed |
| **AgentService** | An Anthropic/Claude loop, another model provider, a local OSS model, or your own agent loop |

Mix and match: a local Docker sandbox with a Postgres session store and a Claude runtime in development; a Firecracker sandbox with the same store and runtime in production, without changing a line of application code.

## Contributing

This is an early-stage, contracts-first project. The best contribution right now is feedback on the interfaces. Open an issue to discuss the protocol, a missing method, or a backend you'd want to plug in.

## License

[Apache 2.0](./LICENSE).
