import type { ProviderEvent } from "@funky/core";
import type { ModelProvider, StreamRequest } from "./model-provider";

/**
 * A scripted ModelProvider for tests: yields the given steps in order.
 * Beyond plain events, a step can throw (provider/network failure) or park
 * until the caller aborts (for testing mid-stream cancellation, mimicking an
 * SDK that raises AbortError when the signal fires).
 *
 * `requests` records every stream() call for assertions.
 */
export type FakeStep = ProviderEvent | { kind: "throw"; error: Error } | { kind: "untilAborted" };

export interface FakeModelProvider extends ModelProvider {
  requests: StreamRequest[];
}

export function createFakeModelProvider(script: FakeStep[]): FakeModelProvider {
  const requests: StreamRequest[] = [];
  return {
    requests,
    async *stream(req: StreamRequest, signal: AbortSignal): AsyncIterable<ProviderEvent> {
      requests.push(req);
      for (const step of script) {
        if ("kind" in step) {
          if (step.kind === "throw") throw step.error;
          await new Promise<void>((resolve) => {
            if (signal.aborted) return resolve();
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
          throw new DOMException("The operation was aborted.", "AbortError");
        }
        yield step;
      }
    },
  };
}
