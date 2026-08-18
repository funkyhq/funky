// Output truncation shared by the workspace tools, following pi's
// contract: two independent limits — 2000 lines and 50KB — whichever is
// hit first, and never a partial line. read keeps the head (the model
// pages forward with offset); bash keeps the tail (errors and final
// results live at the end).

export const MAX_LINES = 2000;
export const MAX_BYTES = 50 * 1024;

export interface Truncation {
  content: string;
  truncated: boolean;
  /** Line counts of the original input and the kept slice. */
  totalLines: number;
  outputLines: number;
  /** True when even the first (head) or last (tail) line alone exceeds
   *  the byte limit, so content is empty or byte-clipped. */
  lineExceedsLimit: boolean;
}

export function truncateHead(text: string): Truncation {
  const lines = splitLines(text);
  if (fits(text, lines)) return whole(text, lines);

  const kept: string[] = [];
  let bytes = 0;
  for (const line of lines.slice(0, MAX_LINES)) {
    const lineBytes = Buffer.byteLength(line, "utf-8") + (kept.length > 0 ? 1 : 0);
    if (bytes + lineBytes > MAX_BYTES) break;
    kept.push(line);
    bytes += lineBytes;
  }
  return {
    content: kept.join("\n"),
    truncated: true,
    totalLines: lines.length,
    outputLines: kept.length,
    lineExceedsLimit: kept.length === 0,
  };
}

export function truncateTail(text: string): Truncation {
  const lines = splitLines(text);
  if (fits(text, lines)) return whole(text, lines);

  const kept: string[] = [];
  let bytes = 0;
  for (let i = lines.length - 1; i >= 0 && kept.length < MAX_LINES; i--) {
    const line = lines[i] as string;
    const lineBytes = Buffer.byteLength(line, "utf-8") + (kept.length > 0 ? 1 : 0);
    if (bytes + lineBytes > MAX_BYTES) break;
    kept.unshift(line);
    bytes += lineBytes;
  }
  if (kept.length === 0) {
    // The last line alone exceeds the limit; keep its byte-clipped end.
    return {
      content: tailBytes(lines[lines.length - 1] as string, MAX_BYTES),
      truncated: true,
      totalLines: lines.length,
      outputLines: 1,
      lineExceedsLimit: true,
    };
  }
  return {
    content: kept.join("\n"),
    truncated: true,
    totalLines: lines.length,
    outputLines: kept.length,
    lineExceedsLimit: false,
  };
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/** Split for counting: a trailing newline does not add an empty line. */
function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split("\n");
  if (text.endsWith("\n")) lines.pop();
  return lines;
}

function fits(text: string, lines: string[]): boolean {
  return lines.length <= MAX_LINES && Buffer.byteLength(text, "utf-8") <= MAX_BYTES;
}

function whole(text: string, lines: string[]): Truncation {
  return {
    content: text,
    truncated: false,
    totalLines: lines.length,
    outputLines: lines.length,
    lineExceedsLimit: false,
  };
}

/** The last maxBytes of a string, clipped on a UTF-8 character boundary. */
function tailBytes(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, "utf-8");
  if (bytes.length <= maxBytes) return text;
  let start = bytes.length - maxBytes;
  while (start < bytes.length && ((bytes[start] as number) & 0xc0) === 0x80) start++;
  return bytes.subarray(start).toString("utf-8");
}
