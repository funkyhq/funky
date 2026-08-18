// The four workspace tools against an in-memory Sandbox fake: pi's
// contracts — bash tail truncation and exit-code reporting, read's
// offset/limit paging and image-by-extension, edit's exactly-once
// matching with CRLF/BOM preservation — plus the same-path serialization
// that makes parallel batches safe. The static-spec projection is pinned
// so the inference branch can declare tools without a sandbox.

import { posix } from "node:path";
import { describe, expect, test } from "vitest";
import type { ToolContext } from "../src/engine/tool";
import type { CommandResult, RunOptions, Sandbox } from "../src/ports/sandbox-provider";
import { MAX_IMAGE_BYTES } from "../src/tools/read";
import { createSandboxTools, sandboxToolSpecs } from "../src/tools/sandbox-tools";
import { MAX_LINES } from "../src/tools/truncate";

type RunFn = (command: string, opts?: RunOptions) => Promise<CommandResult>;

function memorySandbox(run?: RunFn) {
  const files = new Map<string, Uint8Array>();
  const sandbox: Sandbox = {
    sandboxId: "sbx_test",
    getInfo: async () => ({ sandboxId: "sbx_test", state: "running", metadata: {} }),
    run: run ?? (async () => ({ stdout: "", stderr: "", exitCode: 0 })),
    readFile: async (path) => {
      // normalize so lexical aliases hit the same entry, as on a real FS.
      const data = files.get(posix.normalize(path));
      if (!data) throw new Error(`no such file: ${path}`);
      return data;
    },
    writeFile: async (path, data) => {
      files.set(
        posix.normalize(path),
        typeof data === "string" ? new TextEncoder().encode(data) : data,
      );
    },
    pause: async () => {},
    kill: async () => {},
  };
  return { sandbox, files };
}

function ctx(onChunk?: (chunk: string) => void): ToolContext {
  return { signal: new AbortController().signal, onChunk };
}

function textOf(outcome: { content: { type: string; text?: string }[] }): string {
  return outcome.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function fileText(files: Map<string, Uint8Array>, path: string): string {
  // ignoreBOM so the assertions can see whether a BOM survived.
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(files.get(path));
}

async function runTool(sandbox: Sandbox, name: string, args: unknown, context = ctx()) {
  const tool = createSandboxTools(sandbox).get(name);
  if (!tool) throw new Error(`missing tool ${name}`);
  return tool.execute(tool.input.parse(args), context);
}

describe("sandboxToolSpecs", () => {
  test("declares the four tools statically, projected from the same definitions", () => {
    expect(sandboxToolSpecs.map((spec) => spec.name)).toEqual(["bash", "read", "write", "edit"]);
    for (const spec of sandboxToolSpecs) {
      expect(spec.description).toBeTruthy();
      expect(spec.inputSchema).toMatchObject({ type: "object" });
    }
    const { sandbox } = memorySandbox();
    expect([...createSandboxTools(sandbox).keys()]).toEqual(sandboxToolSpecs.map((s) => s.name));
  });
});

describe("bash", () => {
  test("passes the command with seconds converted to timeoutMs and taps output", async () => {
    let seen: { command: string; opts?: RunOptions } | undefined;
    const { sandbox } = memorySandbox(async (command, opts) => {
      seen = { command, opts };
      opts?.onStdout?.("chunk-out");
      opts?.onStderr?.("chunk-err");
      return { stdout: "done", stderr: "", exitCode: 0 };
    });
    const chunks: string[] = [];

    const outcome = await runTool(
      sandbox,
      "bash",
      { command: "make build", timeout: 90 },
      ctx((c) => chunks.push(c)),
    );
    expect(seen?.command).toBe("make build");
    expect(seen?.opts?.timeoutMs).toBe(90_000);
    expect(chunks).toEqual(["chunk-out", "chunk-err"]);
    expect(textOf(outcome)).toBe("done");
    expect(outcome.isError).toBe(false);
  });

  test("reports a non-zero exit as an error result with both streams", async () => {
    const { sandbox } = memorySandbox(async () => ({
      stdout: "partial",
      stderr: "boom",
      exitCode: 7,
    }));

    const outcome = await runTool(sandbox, "bash", { command: "false" });
    expect(textOf(outcome)).toBe("partial\nboom\n\nCommand exited with code 7");
    expect(outcome.isError).toBe(true);
  });

  test("shows (no output) for a silent command", async () => {
    const { sandbox } = memorySandbox();
    expect(textOf(await runTool(sandbox, "bash", { command: "true" }))).toBe("(no output)");
  });

  test("keeps the tail of oversized output", async () => {
    const stdout = Array.from({ length: 3000 }, (_, i) => `line ${i + 1}`).join("\n");
    const { sandbox } = memorySandbox(async () => ({ stdout, stderr: "", exitCode: 0 }));

    const text = textOf(await runTool(sandbox, "bash", { command: "spam" }));
    expect(text).toContain("line 3000");
    expect(text).not.toContain("line 1\n");
    expect(text).toContain(`[Showing lines 1001-3000 of 3000]`);
  });
});

describe("read", () => {
  test("reads a text file whole", async () => {
    const { sandbox } = memorySandbox();
    await sandbox.writeFile("/w/a.txt", "alpha\nbeta\n");

    expect(textOf(await runTool(sandbox, "read", { path: "/w/a.txt" }))).toBe("alpha\nbeta\n");
  });

  test("pages with offset/limit and points at the next offset", async () => {
    const { sandbox } = memorySandbox();
    await sandbox.writeFile("/w/a.txt", "one\ntwo\nthree\nfour\nfive");

    const text = textOf(await runTool(sandbox, "read", { path: "/w/a.txt", offset: 2, limit: 2 }));
    expect(text).toBe("two\nthree\n\n[2 more lines in file. Use offset=4 to continue.]");
  });

  test("rejects an offset beyond the end of the file", async () => {
    const { sandbox } = memorySandbox();
    await sandbox.writeFile("/w/a.txt", "only\n");

    await expect(runTool(sandbox, "read", { path: "/w/a.txt", offset: 10 })).rejects.toThrow(
      "beyond end of file",
    );
  });

  test("truncates a long file head-first with a continuation notice", async () => {
    const { sandbox } = memorySandbox();
    const body = Array.from({ length: 2500 }, (_, i) => `l${i + 1}`).join("\n");
    await sandbox.writeFile("/w/big.txt", body);

    const text = textOf(await runTool(sandbox, "read", { path: "/w/big.txt" }));
    expect(text).toContain(`l${MAX_LINES}`);
    expect(text).not.toContain(`l${MAX_LINES + 1}\n`);
    expect(text).toContain(
      `[Showing lines 1-${MAX_LINES} of 2500. Use offset=${MAX_LINES + 1} to continue.]`,
    );
  });

  test("returns images by extension as base64 content", async () => {
    const { sandbox } = memorySandbox();
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    await sandbox.writeFile("/w/shot.PNG", bytes);

    const outcome = await runTool(sandbox, "read", { path: "/w/shot.PNG" });
    expect(outcome.content).toEqual([
      { type: "text", text: "Read image file [image/png]" },
      { type: "image", data: Buffer.from(bytes).toString("base64"), mimeType: "image/png" },
    ]);
  });

  test("rejects an image over the size cap", async () => {
    const { sandbox } = memorySandbox();
    await sandbox.writeFile("/w/huge.png", new Uint8Array(MAX_IMAGE_BYTES + 1));

    await expect(runTool(sandbox, "read", { path: "/w/huge.png" })).rejects.toThrow(
      "exceeds the 4.0MB limit",
    );
  });
});

describe("write", () => {
  test("writes content and reports the byte count", async () => {
    const { sandbox, files } = memorySandbox();

    const outcome = await runTool(sandbox, "write", { path: "/w/new.txt", content: "fresh\n" });
    expect(fileText(files, "/w/new.txt")).toBe("fresh\n");
    expect(textOf(outcome)).toBe("Wrote 6 bytes to /w/new.txt.");
  });
});

describe("edit", () => {
  test("applies a single exact replacement", async () => {
    const { sandbox, files } = memorySandbox();
    await sandbox.writeFile("/w/a.ts", "const a = 1;\nconst b = 2;\n");

    const outcome = await runTool(sandbox, "edit", {
      path: "/w/a.ts",
      edits: [{ oldText: "const b = 2;", newText: "const b = 3;" }],
    });
    expect(fileText(files, "/w/a.ts")).toBe("const a = 1;\nconst b = 3;\n");
    expect(textOf(outcome)).toBe("Successfully replaced 1 block(s) in /w/a.ts.");
  });

  test("matches every edit against the original file, whatever the given order", async () => {
    const { sandbox, files } = memorySandbox();
    await sandbox.writeFile("/w/a.txt", "first\nsecond\nthird\n");

    await runTool(sandbox, "edit", {
      path: "/w/a.txt",
      edits: [
        { oldText: "third", newText: "3rd" },
        { oldText: "first", newText: "1st" },
      ],
    });
    expect(fileText(files, "/w/a.txt")).toBe("1st\nsecond\n3rd\n");
  });

  const rejections: [string, { oldText: string; newText: string }[], string][] = [
    ["a missing oldText", [{ oldText: "absent", newText: "x" }], "not found"],
    ["an ambiguous oldText", [{ oldText: "dup", newText: "x" }], "matches 2 times"],
    [
      "overlapping edits",
      [
        { oldText: "dup one dup", newText: "x" },
        { oldText: "one", newText: "y" },
      ],
      "overlap",
    ],
    ["an empty oldText", [{ oldText: "", newText: "x" }], "must not be empty"],
    ["a no-op replacement", [{ oldText: "one", newText: "one" }], "identical content"],
  ];
  test.each(rejections)("rejects %s", async (_label, edits, message) => {
    const { sandbox, files } = memorySandbox();
    await sandbox.writeFile("/w/a.txt", "dup one dup\n");

    await expect(runTool(sandbox, "edit", { path: "/w/a.txt", edits })).rejects.toThrow(message);
    expect(fileText(files, "/w/a.txt")).toBe("dup one dup\n"); // untouched on failure
  });

  test("matches LF-authored edits in a CRLF file and preserves its endings and BOM", async () => {
    const { sandbox, files } = memorySandbox();
    await sandbox.writeFile("/w/win.txt", "\uFEFFalpha\r\nbeta\r\n");

    await runTool(sandbox, "edit", {
      path: "/w/win.txt",
      edits: [{ oldText: "alpha\nbeta", newText: "alpha\ngamma" }],
    });
    expect(fileText(files, "/w/win.txt")).toBe("\uFEFFalpha\r\ngamma\r\n");
  });

  test("judges a mixed-ending file by its first newline \u2014 a stray CRLF doesn't flip the file", async () => {
    const { sandbox, files } = memorySandbox();
    await sandbox.writeFile("/w/mixed.txt", "one\ntwo\r\nthree\n");

    await runTool(sandbox, "edit", {
      path: "/w/mixed.txt",
      edits: [{ oldText: "three", newText: "3rd" }],
    });
    // LF-first file stays LF; only the stray CRLF line is homogenized.
    expect(fileText(files, "/w/mixed.txt")).toBe("one\ntwo\n3rd\n");
  });

  test("folds lone CR endings so exact matching still works", async () => {
    const { sandbox, files } = memorySandbox();
    await sandbox.writeFile("/w/mac.txt", "a\rb");

    await runTool(sandbox, "edit", {
      path: "/w/mac.txt",
      edits: [{ oldText: "a\nb", newText: "a\nc" }],
    });
    expect(fileText(files, "/w/mac.txt")).toBe("a\nc");
  });

  test("serializes same-path mutations fired in parallel", async () => {
    const { sandbox, files } = memorySandbox();
    await sandbox.writeFile("/w/a.txt", "seed");
    const tools = createSandboxTools(sandbox);
    const write = tools.get("write");
    const edit = tools.get("edit");
    if (!write || !edit) throw new Error("missing tools");

    // The edit's oldText exists only in the write's content: without the
    // per-path queue its read could see "seed" and fail or lose the write.
    await Promise.all([
      write.execute(write.input.parse({ path: "/w/a.txt", content: "hello world" }), ctx()),
      edit.execute(
        edit.input.parse({ path: "/w/a.txt", edits: [{ oldText: "world", newText: "funky" }] }),
        ctx(),
      ),
    ]);
    expect(fileText(files, "/w/a.txt")).toBe("hello funky");
  });

  test("serializes lexical aliases of the same path", async () => {
    const { sandbox, files } = memorySandbox();
    await sandbox.writeFile("/w/a.txt", "seed");
    const tools = createSandboxTools(sandbox);
    const write = tools.get("write");
    const edit = tools.get("edit");
    if (!write || !edit) throw new Error("missing tools");

    // "/w/./a.txt" and "/w/a.txt" are the same file; the queue must key
    // them together or the edit could read "seed" and lose the write.
    await Promise.all([
      write.execute(write.input.parse({ path: "/w/./a.txt", content: "hello world" }), ctx()),
      edit.execute(
        edit.input.parse({ path: "/w/a.txt", edits: [{ oldText: "world", newText: "funky" }] }),
        ctx(),
      ),
    ]);
    expect(fileText(files, "/w/a.txt")).toBe("hello funky");
  });
});
