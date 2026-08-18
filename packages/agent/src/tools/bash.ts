import { z } from "zod";
import type { Tool, ToolDefinition } from "../engine/tool";
import type { Sandbox } from "../ports/sandbox-provider";
import { formatSize, MAX_BYTES, MAX_LINES, truncateTail } from "./truncate";

export const bashDefinition = {
  name: "bash",
  description:
    "Execute a bash command in the workspace. Returns stdout and stderr. " +
    `Output is truncated to the last ${MAX_LINES} lines or ${MAX_BYTES / 1024}KB ` +
    "(whichever is hit first). Optionally provide a timeout in seconds; " +
    "the sandbox's default applies otherwise.",
  input: z.object({
    command: z.string().describe("Bash command to execute"),
    timeout: z.number().positive().optional().describe("Timeout in seconds"),
  }),
} satisfies ToolDefinition;

export function bindBash(sandbox: Sandbox): Tool {
  return {
    ...bashDefinition,
    async execute(args, ctx) {
      const { command, timeout } = args as z.infer<typeof bashDefinition.input>;
      const result = await sandbox.run(command, {
        timeoutMs: timeout === undefined ? undefined : Math.round(timeout * 1000),
        onStdout: ctx.onChunk,
        onStderr: ctx.onChunk,
      });

      // A command timeout surfaces here as exit 124 (the port settles it
      // as the command's own outcome), so it reads like any other failure.
      const merged = [result.stdout, result.stderr].filter((part) => part.length > 0).join("\n");
      const truncation = truncateTail(merged);
      let text = truncation.content || "(no output)";
      if (truncation.truncated) {
        const start = truncation.totalLines - truncation.outputLines + 1;
        text += truncation.lineExceedsLimit
          ? `\n\n[Showing the last ${formatSize(MAX_BYTES)} of line ${truncation.totalLines}]`
          : `\n\n[Showing lines ${start}-${truncation.totalLines} of ${truncation.totalLines}]`;
      }
      if (result.exitCode !== 0) {
        text += `\n\nCommand exited with code ${result.exitCode}`;
      }
      return { content: [{ type: "text", text }], isError: result.exitCode !== 0 };
    },
  };
}
