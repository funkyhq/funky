import { z } from "zod";
import type { Tool, ToolDefinition } from "../engine/tool";
import type { Sandbox } from "../ports/sandbox-provider";
import type { FileQueue } from "./file-queue";

export const writeDefinition = {
  name: "write",
  description:
    "Create or overwrite a file with the given content. Parent " +
    "directories are created as needed. Use write only for new files or " +
    "complete rewrites; use edit for targeted changes.",
  input: z.object({
    path: z.string().describe("Path to the file to write"),
    content: z.string().describe("Content to write to the file"),
  }),
} satisfies ToolDefinition;

export function bindWrite(sandbox: Sandbox, queue: FileQueue): Tool {
  return {
    ...writeDefinition,
    async execute(args) {
      const { path, content } = args as z.infer<typeof writeDefinition.input>;
      await queue(path, () => sandbox.writeFile(path, content));
      return {
        content: [
          { type: "text", text: `Wrote ${Buffer.byteLength(content, "utf-8")} bytes to ${path}.` },
        ],
      };
    },
  };
}
