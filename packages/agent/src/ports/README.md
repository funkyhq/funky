# ports/

The contracts the engine and the driver (the claim → step → commit loop
in `../driver`) consume. Implementations live downstream in
`packages/adapters`; this directory defines what they must be, never
what they are.

| port                | one line                                                |
| ------------------- | ------------------------------------------------------- |
| `InferenceProvider` | one request in, one live stream of increments out       |
| `Store`             | the single source of truth: 17 methods, two write paths |

Why the ports live here and not elsewhere:

- **A port lives with its consumer, not its implementations.**
  `InferenceProvider` is literally the parameter type of `inference()`;
  `Store.commitStep` speaks the engine's `RunEndStatus`. Vocabulary lives
  with its interpreter.
- **Port-argument shapes stay here too.** `StreamRequest` and
  `CommitStepRequest` are in-process call shapes, spoken by one caller to
  one method — they never persist, so they are plain interfaces beside
  their port, not zod schemas in core. Core keeps only what multiple
  layers share: the rows and results (`Create*Request`, `IntakeResult`)
  that cross a trust boundary or round-trip through storage.
- **The fake sits beside the port it fakes.** Agent's own tests script
  `FakeInferenceProvider`; moving it to `adapters` would make agent's
  tests import a package that imports agent. Downstream packages get it
  for free from here.

Adapters are held to these contracts behaviorally, not just structurally:
the Store conformance suite (in `packages/adapters`) runs against every
implementation on every binding. If a port's jsdoc promises it, the
suite pins it.
