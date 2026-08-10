// packages/ports/sandbox/src/drivers/e2b.ts — error-transparent E2B provider.
//
// @computesdk/e2b's getById does `catch { return null }`: it folds EVERY failure —
// a destroyed sandbox AND a transport blip — into null. ComputeSdkDriver's provider
// contract needs those apart (null ⇒ positively gone, throw ⇒ unreachable), because
// the turn loop's error policy treats "gone" as terminal. This wrapper restores the
// distinction with one raw e2b SDK probe on the null path only: Sandbox.connect()
// throws SandboxNotFoundError exactly when the API answered 404 (the sandbox no
// longer exists) and rejects with anything else on transport/API failures. The happy
// path stays a single provider call; connect() on a paused sandbox resumes it, which
// is the reconnect path's job anyway.

import { e2b } from "@computesdk/e2b";
import { Sandbox as E2BSandbox, SandboxNotFoundError } from "e2b";
import type { ComputeProvider } from "./computesdk";

export type E2bProviderOptions = { apiKey: string };

/** The probe seam: resolves if the sandbox exists (resuming it if paused), throws
 *  SandboxNotFoundError if the API positively reported it gone, rejects otherwise. */
export type E2bProbe = (sandboxId: string) => Promise<unknown>;

export function e2bProvider(opts: E2bProviderOptions): ComputeProvider {
  return withProbedGetById(e2b({ apiKey: opts.apiKey }), (id) =>
    E2BSandbox.connect(id, { apiKey: opts.apiKey }),
  );
}

/** The wrap itself, split from e2bProvider so tests can inject both seams. */
export function withProbedGetById(base: ComputeProvider, probe: E2bProbe): ComputeProvider {
  return {
    ...base,
    sandbox: {
      ...base.sandbox,
      getById: async (sandboxId) => {
        const sb = await base.sandbox.getById(sandboxId);
        if (sb) return sb;
        try {
          await probe(sandboxId);
        } catch (err) {
          if (err instanceof SandboxNotFoundError) return null; // positively gone
          throw err; // transport / API failure → the driver reads this as unreachable
        }
        // The probe reached it, so the base provider's null was itself a swallowed blip.
        throw new Error(`e2b sandbox ${sandboxId} exists but the provider could not attach to it`);
      },
    },
  };
}
