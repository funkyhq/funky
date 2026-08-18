// Exact-text replacement with pi's exactly-once contract: every
// edits[].oldText must match exactly one region of the ORIGINAL file —
// never the output of an earlier edit — and regions must not overlap.
// Matching runs on LF-normalized, BOM-stripped text so a CRLF file or an
// invisible BOM can't fail an edit the model wrote correctly; the
// original line endings and BOM are restored on write.

import { z } from "zod";
import type { Tool, ToolDefinition } from "../engine/tool";
import type { Sandbox } from "../ports/sandbox-provider";
import type { FileQueue } from "./file-queue";

const editEntry = z.object({
  oldText: z
    .string()
    .describe(
      "Exact text for one targeted replacement. It must be unique in the " +
        "original file and must not overlap with any other edits[].oldText " +
        "in the same call.",
    ),
  newText: z.string().describe("Replacement text for this targeted edit."),
});

export const editDefinition = {
  name: "edit",
  description:
    "Edit a single file using exact text replacement. Every " +
    "edits[].oldText must match a unique, non-overlapping region of the " +
    "original file. If two changes affect the same block or nearby lines, " +
    "merge them into one edit. Keep oldText as small as possible while " +
    "still being unique.",
  input: z.object({
    path: z.string().describe("Path to the file to edit"),
    edits: z
      .array(editEntry)
      .min(1)
      .describe(
        "One or more targeted replacements. Each edit is matched against " +
          "the original file, not incrementally.",
      ),
  }),
} satisfies ToolDefinition;

export function bindEdit(sandbox: Sandbox, queue: FileQueue): Tool {
  return {
    ...editDefinition,
    async execute(args) {
      const { path, edits } = args as z.infer<typeof editDefinition.input>;
      return queue(path, async () => {
        // ignoreBOM keeps a BOM visible to the code below — the default
        // decoder would silently strip it and the write would drop it.
        const raw = new TextDecoder("utf-8", { ignoreBOM: true }).decode(
          await sandbox.readFile(path),
        );
        const bom = raw.startsWith("\uFEFF") ? "\uFEFF" : "";
        const original = raw.slice(bom.length);
        const ending = detectLineEnding(original);
        const content = normalizeToLF(original);

        const applied = applyEdits(content, edits, path);
        const restored = ending === "\r\n" ? applied.replaceAll("\n", "\r\n") : applied;
        await sandbox.writeFile(path, bom + restored);
        return {
          content: [
            { type: "text", text: `Successfully replaced ${edits.length} block(s) in ${path}.` },
          ],
        };
      });
    },
  };
}

interface Match {
  editIndex: number;
  start: number;
  length: number;
  newText: string;
}

function applyEdits(
  content: string,
  edits: { oldText: string; newText: string }[],
  path: string,
): string {
  const matches: Match[] = edits.map((edit, editIndex) => {
    const oldText = normalizeToLF(edit.oldText);
    if (oldText.length === 0)
      throw editError(path, edits.length, editIndex, "oldText must not be empty");
    const occurrences = content.split(oldText).length - 1;
    if (occurrences === 0) {
      throw editError(
        path,
        edits.length,
        editIndex,
        "the oldText was not found — it must match exactly, including all whitespace and newlines",
      );
    }
    if (occurrences > 1) {
      throw editError(
        path,
        edits.length,
        editIndex,
        `the oldText matches ${occurrences} times and must be unique — provide more surrounding context`,
      );
    }
    return {
      editIndex,
      start: content.indexOf(oldText),
      length: oldText.length,
      newText: normalizeToLF(edit.newText),
    };
  });

  matches.sort((a, b) => a.start - b.start);
  for (let i = 1; i < matches.length; i++) {
    const previous = matches[i - 1] as Match;
    const current = matches[i] as Match;
    if (previous.start + previous.length > current.start) {
      throw new Error(
        `edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${path}. ` +
          "Merge them into one edit or target disjoint regions.",
      );
    }
  }

  // Reverse order keeps earlier offsets valid as later regions change size.
  let result = content;
  for (const match of [...matches].reverse()) {
    result =
      result.slice(0, match.start) + match.newText + result.slice(match.start + match.length);
  }
  if (result === content) {
    throw new Error(`No changes made to ${path}. The replacements produced identical content.`);
  }
  return result;
}

function editError(path: string, totalEdits: number, editIndex: number, reason: string): Error {
  const subject = totalEdits === 1 ? "" : `edits[${editIndex}]: `;
  return new Error(`Could not edit ${path}. ${subject}${reason}.`);
}

/**
 * The file's ending is judged by its FIRST newline (pi's heuristic), so
 * one stray CRLF in an LF file rewrites only the stray line on restore —
 * any-CRLF-wins would flip every line in the file.
 */
function detectLineEnding(content: string): "\r\n" | "\n" {
  const crlfIdx = content.indexOf("\r\n");
  const lfIdx = content.indexOf("\n");
  if (lfIdx === -1 || crlfIdx === -1) return "\n";
  return crlfIdx < lfIdx ? "\r\n" : "\n";
}

/** Folds CRLF and lone CR (classic-Mac) endings, like pi's. */
function normalizeToLF(text: string): string {
  return text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}
