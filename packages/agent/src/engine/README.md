# engine/

The step functions of the harness — pure, no I/O of their own. Their
caller is the **driver** (`../driver`): the claim → step → commit loop,
written as a library and hosted by a worker process (`apps/worker`) —
the Store port's "two callers" are the api (intake) and that loop
(commitStep). Nothing here knows the loop exists.

| function       | shape                                                            |
| -------------- | ---------------------------------------------------------------- |
| `buildContext` | session entries → model context (repair, steering drain)         |
| `inference`    | provider stream → one `AssistantMessage`                         |
| `executeTools` | tool calls → one `ToolResultMessage` per call, in order          |
| `nextAction`   | `(message, cancelRequested)` → `Action` — the step's consequence |

Rules that keep this directory what it is:

- **Messages and entries only.** The engine imports none of the store
  vocabulary — no sessions, items, or inputs. `nextAction`'s
  `cancelRequested` input is computed by the driver at each boundary from
  the log's control entries; the engine never sees the log's envelope.
- **All effects arrive as arguments.** Model access comes in as an
  `InferenceProvider`, tools as plain objects, cancellation as an
  `AbortSignal`. A function here is fully exercised by unit tests with
  fakes — no loop, no store, no clock.
- **The engine decides; the driver persists.** `nextAction` returns the
  consequence, `commitStep` (a Store port concern) makes it durable. If a
  change here wants to write something, it belongs in the driver or the
  store, not the engine.

A run — one accepted user message through to the agent's completion — is
derived vocabulary. Nothing in this directory (or anywhere) stores one.
