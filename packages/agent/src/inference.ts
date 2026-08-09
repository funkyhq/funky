import type { AgentMessage, AssistantMessage, ProviderEvent, ToolSpec } from "@funky/core";
import type { ModelProvider } from "./model-provider";

export async function inference(
  deps: {
    provider: ModelProvider;
    onDelta?: (e: ProviderEvent) => void;  // sync fire-and-forget tap
  },
  req: {
    model: string;
    system: string;
    context: AgentMessage[];
    tools: ToolSpec[]
  },
  signal: AbortSignal,
): Promise<AssistantMessage> {
  throw new Error("not implemented: the fold");
}
