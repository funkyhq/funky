// The e2b adapter's translation layer, pinned against a mocked SDK: the
// explicit lifecycle default (the SDK's own is "kill"), the NetworkPolicy
// mapping, the package-template path (its build state machine has its own
// suite, e2b-packages.test.ts), exit/timeout errors settling as results, the one-reconnect
// recovery, and the Uint8Array → ArrayBuffer copy. The real SDK is
// exercised by the key-gated live suite in e2b-live.test.ts.

import { beforeEach, describe, expect, test, vi } from "vitest";
import { SandboxNotFoundError, SandboxProvisionError } from "@funky/agent";
import { createE2bProvider } from "../src/sandbox/e2b";

const mocks = vi.hoisted(() => {
  class CommandExitError extends Error {
    constructor(
      readonly exitCode: number,
      readonly stdout: string,
      readonly stderr: string,
    ) {
      super(`exit status ${exitCode}`);
    }
  }
  class TimeoutError extends Error {}
  class SandboxNotFoundError extends Error {}
  class SandboxError extends Error {}
  return {
    CommandExitError,
    TimeoutError,
    SandboxNotFoundError,
    SandboxError,
    ensureTemplate: vi.fn(),
    create: vi.fn(),
    connect: vi.fn(),
    getInfo: vi.fn(),
    list: vi.fn(),
  };
});

vi.mock("e2b", () => ({
  CommandExitError: mocks.CommandExitError,
  TimeoutError: mocks.TimeoutError,
  SandboxNotFoundError: mocks.SandboxNotFoundError,
  SandboxError: mocks.SandboxError,
  Sandbox: class {
    static create = mocks.create;
    static connect = mocks.connect;
    static getInfo = mocks.getInfo;
    static list = mocks.list;
  },
}));

// The package helpers stay real; only the build itself is stubbed.
vi.mock("../src/sandbox/e2b-packages", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/sandbox/e2b-packages")>()),
  e2bTemplateBuilds: () => ({ fake: "builds" }),
  ensureTemplate: mocks.ensureTemplate,
}));

function fakeSandbox(overrides?: { run?: ReturnType<typeof vi.fn> }) {
  return {
    sandboxId: "sbx_1",
    commands: { run: overrides?.run ?? vi.fn() },
    files: { read: vi.fn(), write: vi.fn() },
    pause: vi.fn(),
    kill: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("createE2bProvider", () => {
  test("create passes the port's pause default explicitly — the SDK's own onTimeout default is kill", async () => {
    mocks.create.mockResolvedValue(fakeSandbox());
    const provider = createE2bProvider();

    await provider.create();
    expect(mocks.create).toHaveBeenLastCalledWith(
      expect.objectContaining({ lifecycle: { onTimeout: "pause" } }),
    );

    await provider.create({ timeoutMs: 60_000, lifecycle: "kill", metadata: { sessionId: "s1" } });
    expect(mocks.create).toHaveBeenLastCalledWith(
      expect.objectContaining({
        timeoutMs: 60_000,
        lifecycle: { onTimeout: "kill" },
        metadata: { sessionId: "s1" },
      }),
    );
  });

  test("create maps every NetworkPolicy variant", async () => {
    mocks.create.mockResolvedValue(fakeSandbox());
    const provider = createE2bProvider();

    await provider.create({ network: { type: "unrestricted" } });
    expect(mocks.create.mock.lastCall?.[0]).not.toHaveProperty("allowInternetAccess");
    expect(mocks.create.mock.lastCall?.[0]).not.toHaveProperty("network");

    await provider.create({ network: { type: "none" } });
    expect(mocks.create.mock.lastCall?.[0]).toMatchObject({ allowInternetAccess: false });

    await provider.create({ network: { type: "allowlist", domains: ["api.example.com"] } });
    expect(mocks.create.mock.lastCall?.[0]).toMatchObject({
      network: { allowOut: ["api.example.com"] },
    });
  });

  test("create with no packages starts from the default template", async () => {
    mocks.create.mockResolvedValue(fakeSandbox());
    const provider = createE2bProvider();

    await provider.create({ packages: {} });
    await provider.create({ packages: { pip: [] } });
    for (const call of mocks.create.mock.calls) {
      expect(call).toHaveLength(1); // opts only — no template name
      expect(call[0]).not.toHaveProperty("envs");
    }
  });

  test("create goes straight to a built package template — no build lookups", async () => {
    mocks.create.mockResolvedValue(fakeSandbox());
    const provider = createE2bProvider();

    await provider.create({ packages: { pip: ["pandas==2.2.0", "numpy"] }, metadata: { s: "1" } });
    // Same set, written differently: the same template.
    await provider.create({ packages: { pip: ["numpy", "pandas==2.2.0", "numpy"] } });
    const [first, second] = mocks.create.mock.calls;
    expect(first?.[0]).toMatch(/^funky-pkgs-[0-9a-f]{24}$/);
    expect(second?.[0]).toBe(first?.[0]);
    expect(first?.[1]).toMatchObject({ metadata: { s: "1" } });
    expect(first?.[1]).not.toHaveProperty("envs"); // no npm, no NODE_PATH
    expect(mocks.ensureTemplate).not.toHaveBeenCalled();
  });

  test("create sets NODE_PATH when npm packages are asked for", async () => {
    mocks.create.mockResolvedValue(fakeSandbox());
    await createE2bProvider().create({ packages: { npm: ["zod@4"] } });
    expect(mocks.create.mock.lastCall?.[1]).toMatchObject({
      envs: { NODE_PATH: "/usr/local/lib/node_modules" },
    });
  });

  test("create builds an unbuilt template, then creates from it", async () => {
    mocks.create
      .mockRejectedValueOnce(new mocks.SandboxError("404: tag 'default' does not exist"))
      .mockResolvedValueOnce(fakeSandbox());
    const provider = createE2bProvider();

    await provider.create({ packages: { pip: ["it's>=1"], apt: ["graphviz"] } });
    expect(mocks.ensureTemplate).toHaveBeenCalledWith(
      { fake: "builds" },
      mocks.create.mock.calls[0]?.[0],
      [
        "apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y 'graphviz'",
        "pip install 'it'\\''s>=1'",
      ],
    );
    expect(mocks.create).toHaveBeenCalledTimes(2);
  });

  test("create rejects what it cannot install, and lets other failures through", async () => {
    const provider = createE2bProvider();

    const cargo = provider.create({ packages: { cargo: ["ripgrep"], pip: ["numpy"] } });
    await expect(cargo).rejects.toBeInstanceOf(SandboxProvisionError);
    await expect(cargo).rejects.toThrow("cannot install cargo packages");
    expect(mocks.create).not.toHaveBeenCalled();

    mocks.ensureTemplate.mockRejectedValueOnce(new SandboxProvisionError("package install failed"));
    mocks.create.mockRejectedValueOnce(new mocks.SandboxError("404: template not found"));
    await expect(provider.create({ packages: { pip: ["nope==99"] } })).rejects.toBeInstanceOf(
      SandboxProvisionError,
    );

    // Not a 404: no build, the error propagates untyped (transient).
    mocks.create.mockRejectedValueOnce(new mocks.SandboxError("500: internal"));
    await expect(provider.create({ packages: { pip: ["numpy"] } })).rejects.toThrow(
      "500: internal",
    );
    expect(mocks.ensureTemplate).toHaveBeenCalledTimes(1);
  });

  test("connect rides e2b's auto-resuming connect — no state check first", async () => {
    const provider = createE2bProvider();
    mocks.connect.mockResolvedValue(fakeSandbox());

    await provider.connect("sbx_1");
    expect(mocks.getInfo).not.toHaveBeenCalled();
    expect(mocks.connect).toHaveBeenCalledWith("sbx_1", expect.anything());
  });

  test("connect maps a missing sandbox to the port's typed rejection", async () => {
    const provider = createE2bProvider();
    mocks.connect.mockRejectedValue(new mocks.SandboxNotFoundError("sandbox sbx_gone not found"));

    await expect(provider.connect("sbx_gone")).rejects.toBeInstanceOf(SandboxNotFoundError);

    // A transient failure stays untyped — recovery must not fire on it.
    mocks.connect.mockRejectedValue(new Error("fetch failed"));
    await expect(provider.connect("sbx_1")).rejects.toThrow("fetch failed");
  });

  test("list drains every page and maps to the port's info shape", async () => {
    const pages = [
      [{ sandboxId: "a", state: "running", metadata: { sessionId: "s1" }, extra: "dropped" }],
      [{ sandboxId: "b", state: "paused", metadata: {} }],
    ];
    mocks.list.mockReturnValue({
      get hasNext() {
        return pages.length > 0;
      },
      nextItems: vi.fn(async () => pages.shift()),
    });
    const provider = createE2bProvider();

    const infos = await provider.list({ metadata: { sessionId: "s1" } });
    expect(mocks.list).toHaveBeenCalledWith(
      expect.objectContaining({ query: { metadata: { sessionId: "s1" } } }),
    );
    expect(infos).toEqual([
      { sandboxId: "a", state: "running", metadata: { sessionId: "s1" } },
      { sandboxId: "b", state: "paused", metadata: {} },
    ]);
  });
});

describe("sandbox.run", () => {
  async function createdSandbox(run: ReturnType<typeof vi.fn>) {
    mocks.create.mockResolvedValue(fakeSandbox({ run }));
    return createE2bProvider().create();
  }

  test("a non-zero exit settles as a result without reconnecting", async () => {
    const run = vi.fn().mockRejectedValue(new mocks.CommandExitError(7, "partial", "boom"));
    const sandbox = await createdSandbox(run);

    await expect(sandbox.run("false")).resolves.toEqual({
      stdout: "partial",
      stderr: "boom",
      exitCode: 7,
    });
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  test("a command-deadline timeout settles as exit 124 without retrying", async () => {
    const message =
      "[deadline_exceeded] the operation timed out: This error is likely due to exceeding 'timeoutMs'";
    const run = vi.fn().mockRejectedValue(new mocks.TimeoutError(message));
    const sandbox = await createdSandbox(run);

    await expect(sandbox.run("sleep 99", { timeoutMs: 10 })).resolves.toEqual({
      stdout: "",
      stderr: message,
      exitCode: 124,
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  test("a sandbox-death timeout reconnects instead of settling", async () => {
    const run = vi
      .fn()
      .mockRejectedValue(
        new mocks.TimeoutError(
          "[unavailable] error: The sandbox was killed or reached its end of life while the request was in flight.",
        ),
      );
    const sandbox = await createdSandbox(run);
    const revivedRun = vi.fn().mockResolvedValue({ stdout: "revived", stderr: "", exitCode: 0 });
    mocks.connect.mockResolvedValue(fakeSandbox({ run: revivedRun }));

    await expect(sandbox.run("echo hi")).resolves.toEqual({
      stdout: "revived",
      stderr: "",
      exitCode: 0,
    });
    expect(mocks.connect).toHaveBeenCalledWith("sbx_1", expect.anything());
  });

  test("an unreachable sandbox gets one reconnect-and-retry", async () => {
    const run = vi.fn().mockRejectedValue(new Error("fetch failed"));
    const sandbox = await createdSandbox(run);
    const revivedRun = vi
      .fn()
      .mockResolvedValue({ stdout: "after revive", stderr: "", exitCode: 0 });
    mocks.connect.mockResolvedValue(fakeSandbox({ run: revivedRun }));

    await expect(sandbox.run("echo hi")).resolves.toEqual({
      stdout: "after revive",
      stderr: "",
      exitCode: 0,
    });
    expect(mocks.connect).toHaveBeenCalledWith("sbx_1", expect.anything());

    // The reconnected instance stays in use for later commands.
    await sandbox.run("echo again");
    expect(revivedRun).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenCalledTimes(1);
  });

  test("run throws when the sandbox stays unreachable after recovery", async () => {
    const run = vi.fn().mockRejectedValue(new Error("fetch failed"));
    const sandbox = await createdSandbox(run);
    mocks.connect.mockResolvedValue(fakeSandbox({ run }));

    await expect(sandbox.run("echo hi")).rejects.toThrow("fetch failed");
    expect(mocks.connect).toHaveBeenCalledTimes(1);
  });
});

describe("sandbox files", () => {
  async function createdSandbox() {
    const inner = fakeSandbox();
    mocks.create.mockResolvedValue(inner);
    return { inner, sandbox: await createE2bProvider().create() };
  }

  test("readFile requests bytes", async () => {
    const { inner, sandbox } = await createdSandbox();
    inner.files.read.mockResolvedValue(new Uint8Array([1, 2]));

    await expect(sandbox.readFile("/a.bin")).resolves.toEqual(new Uint8Array([1, 2]));
    expect(inner.files.read).toHaveBeenCalledWith("/a.bin", { format: "bytes" });
  });

  test("writeFile copies a Uint8Array view into an exact ArrayBuffer", async () => {
    const { inner, sandbox } = await createdSandbox();
    // A view into a larger buffer — the copy must honor offset and length.
    const view = new Uint8Array([9, 1, 2, 3, 9]).subarray(1, 4);

    await sandbox.writeFile("/a.bin", view);
    const payload = inner.files.write.mock.calls[0]?.[1] as ArrayBuffer;
    expect(payload).toBeInstanceOf(ArrayBuffer);
    expect(Array.from(new Uint8Array(payload))).toEqual([1, 2, 3]);

    await sandbox.writeFile("/a.txt", "plain text");
    expect(inner.files.write).toHaveBeenLastCalledWith("/a.txt", "plain text");
  });
});
