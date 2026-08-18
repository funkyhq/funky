// Find-or-revive the session's sandbox — the ensure-on-claim half of
// the ratified lifecycle, composed from the port's list/connect/create.
// The provider is the registry: the sandbox is found by {sessionId}
// metadata, so there is no Store column to keep consistent. connect
// revives a paused sandbox in place; only when nothing is found is one
// created, stamped with the session id.
//
// The composition root closes the driver's `bindTools` dep over this:
//   bindTools: (sessionId) =>
//     ensureSandbox(provider, sessionId, opts).then(createSandboxTools)
//
// Two claimers can race here — a zombie whose lease expired and its
// replacement may both list nothing and both create. Harmless: the
// zombie's step is never committed and its orphan is GC'd by the TTL.
// The deterministic pick keeps every later claim converging on one
// survivor in the meantime.

import type { SessionId } from "@funky/core";
import type { CreateSandboxOptions, Sandbox, SandboxProvider } from "../ports/sandbox-provider";

export async function ensureSandbox(
  provider: SandboxProvider,
  sessionId: SessionId,
  createOpts?: CreateSandboxOptions,
): Promise<Sandbox> {
  const infos = await provider.list({ metadata: { sessionId } });
  const found = [...infos].sort((a, b) => a.sandboxId.localeCompare(b.sandboxId))[0];
  if (found) return provider.connect(found.sandboxId);
  return provider.create({
    ...createOpts,
    metadata: { ...createOpts?.metadata, sessionId },
  });
}
