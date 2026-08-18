import { z } from "zod";
import type { Tool, ToolDefinition } from "../engine/tool";
import type { Sandbox } from "../ports/sandbox-provider";
import { formatSize, MAX_BYTES, MAX_LINES, truncateHead } from "./truncate";

// Images are detected by extension — the tool's ratified contract; the
// model names the file it wants, it can rename if an extension lies.
const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
};

// Provider request limits sit around 5MB per image; cap below it. There
// is no resizing in the sandbox, so an oversized image is an error the
// model can route around (e.g. convert via bash).
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

export const readDefinition = {
  name: "read",
  description:
    "Read the contents of a file. Supports text files and images " +
    "(jpg, png, gif, webp, bmp). For text files, output is truncated to " +
    `${MAX_LINES} lines or ${MAX_BYTES / 1024}KB (whichever is hit first). ` +
    "Use offset/limit for large files; when you need the full file, " +
    "continue with offset until complete.",
  input: z.object({
    path: z.string().describe("Path to the file to read"),
    offset: z.number().int().min(1).optional().describe("Line number to start from (1-indexed)"),
    limit: z.number().int().min(1).optional().describe("Maximum number of lines to read"),
  }),
} satisfies ToolDefinition;

export function bindRead(sandbox: Sandbox): Tool {
  return {
    ...readDefinition,
    async execute(args) {
      const { path, offset, limit } = args as z.infer<typeof readDefinition.input>;
      const bytes = await sandbox.readFile(path);

      const mimeType = IMAGE_MIME[path.split(".").pop()?.toLowerCase() ?? ""];
      if (mimeType) {
        if (bytes.byteLength > MAX_IMAGE_BYTES) {
          throw new Error(
            `Image is ${formatSize(bytes.byteLength)}, exceeds the ` +
              `${formatSize(MAX_IMAGE_BYTES)} limit for ${path}.`,
          );
        }
        return {
          content: [
            { type: "text", text: `Read image file [${mimeType}]` },
            { type: "image", data: Buffer.from(bytes).toString("base64"), mimeType },
          ],
        };
      }

      const lines = new TextDecoder().decode(bytes).split("\n");
      const start = offset === undefined ? 0 : offset - 1;
      if (start >= lines.length) {
        throw new Error(`Offset ${offset} is beyond end of file (${lines.length} lines total)`);
      }
      const end = limit === undefined ? lines.length : Math.min(start + limit, lines.length);
      const truncation = truncateHead(lines.slice(start, end).join("\n"));

      let text = truncation.content;
      if (truncation.lineExceedsLimit) {
        // Even one line blows the byte budget; point the model at bash.
        text =
          `[Line ${start + 1} exceeds the ${formatSize(MAX_BYTES)} limit. ` +
          `Use bash: sed -n '${start + 1}p' ${path} | head -c ${MAX_BYTES}]`;
      } else if (truncation.truncated) {
        const lastShown = start + truncation.outputLines;
        text +=
          `\n\n[Showing lines ${start + 1}-${lastShown} of ${lines.length}. ` +
          `Use offset=${lastShown + 1} to continue.]`;
      } else if (end < lines.length) {
        text +=
          `\n\n[${lines.length - end} more lines in file. ` + `Use offset=${end + 1} to continue.]`;
      }
      return { content: [{ type: "text", text }] };
    },
  };
}
