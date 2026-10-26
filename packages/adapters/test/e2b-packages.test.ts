// Package templates on E2B, without E2B: the canonical form and the name
// it hashes to, the quoting E2B's own installers lack, the build's steps
// (installs as root, then setup as the sandbox's user), and ensureTemplate's
// state machine against a scripted TemplateBuilds — above all the
// concurrency rules the live probes forced (wait on an in-flight build,
// never start a rival; only our own failed step is permanent). The
// real API is exercised by the key-gated live suite in e2b-live.test.ts.

import { describe, expect, test, vi } from "vitest";
import { SandboxProvisionError } from "@funky/agent";
import {
  assertInstallable,
  type BuildState,
  type BuildStep,
  buildSteps,
  canonicalPackages,
  ensureTemplate,
  shellQuote,
  type TemplateBuilds,
  templateName,
} from "../src/sandbox/e2b-packages";

describe("canonical package sets", () => {
  test("sort managers and specs, dedupe, and drop empty managers", () => {
    expect(
      canonicalPackages({ pip: ["pandas", "numpy", "pandas"], apt: ["graphviz"], npm: [] }),
    ).toEqual([
      ["apt", ["graphviz"]],
      ["pip", ["numpy", "pandas"]],
    ]);
    expect(canonicalPackages({})).toEqual([]);
  });

  test("equal sets name the same template; any difference names another", () => {
    const name = templateName(canonicalPackages({ pip: ["numpy", "pandas"], apt: ["git"] }));
    expect(name).toMatch(/^funky-pkgs-[0-9a-f]{24}$/);
    expect(templateName(canonicalPackages({ apt: ["git"], pip: ["pandas", "numpy"] }))).toBe(name);
    expect(
      templateName(canonicalPackages({ pip: ["numpy", "pandas==2.2.0"], apt: ["git"] })),
    ).not.toBe(name);
    // The same spec under another manager is another build.
    expect(templateName(canonicalPackages({ npm: ["zod"] }))).not.toBe(
      templateName(canonicalPackages({ pip: ["zod"] })),
    );
  });

  test("setup joins the name only when there is some — older templates keep theirs", () => {
    const numpy = canonicalPackages({ pip: ["numpy"] });
    // The name this set had before setup commands existed.
    expect(templateName(numpy)).toBe("funky-pkgs-b2fb9f11e388088f3dae1471");
    expect(templateName(numpy, [])).toBe(templateName(numpy));

    const setup = ["monid keys add --key monid_x_y --label funky"];
    expect(templateName(numpy, setup)).not.toBe(templateName(numpy));
    expect(templateName(numpy, setup)).toBe(templateName(numpy, [...setup]));
    // Setup alone is a template of its own.
    expect(templateName([], setup)).not.toBe(templateName([]));
    expect(templateName([], setup)).not.toBe(templateName(numpy, setup));
  });

  test("setup is not canonicalized: another order is another build", () => {
    expect(templateName([], ["a", "b"])).not.toBe(templateName([], ["b", "a"]));
    expect(templateName([], ["a", "a"])).not.toBe(templateName([], ["a"]));
  });

  test("rejects managers without an installer", () => {
    expect(() => assertInstallable(canonicalPackages({ pip: ["numpy"] }))).not.toThrow();
    expect(() =>
      assertInstallable(canonicalPackages({ gem: ["rails"], cargo: ["rg"], pip: ["x"] })),
    ).toThrow(
      new SandboxProvisionError(
        "the E2B sandbox provider cannot install cargo, gem packages (it installs: apt, npm, pip)",
      ),
    );
  });
});

describe("build steps", () => {
  test("quote every spec — the shell sees each one literally", () => {
    expect(shellQuote("pandas>=2.0")).toBe("'pandas>=2.0'");
    expect(shellQuote("a b; rm -rf / | $(x) `y` <z")).toBe("'a b; rm -rf / | $(x) `y` <z'");
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });

  test("one command per manager, in canonical order, as root's global install", () => {
    expect(buildSteps(canonicalPackages({ pip: ["six<2"], npm: ["zod@4"], apt: ["git"] }))).toEqual(
      [
        {
          command: "apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y 'git'",
          user: "root",
          label: "package install",
        },
        { command: "npm install -g 'zod@4'", user: "root", label: "package install" },
        { command: "pip install 'six<2'", user: "root", label: "package install" },
      ],
    );
  });

  test("setup runs after the installs, verbatim and in order, as the sandbox's user", () => {
    const setup = ["monid keys add --key monid_x_y --label funky", "cat > a <<'EOF'\nb\nEOF"];
    expect(buildSteps(canonicalPackages({ npm: ["@monid-ai/cli"] }), setup)).toEqual([
      { command: "npm install -g '@monid-ai/cli'", user: "root", label: "package install" },
      { command: setup[0], user: "user", label: "setupCommands.0" },
      { command: setup[1], user: "user", label: "setupCommands.1" },
    ]);
    expect(buildSteps([], ["true"])).toEqual([
      { command: "true", user: "user", label: "setupCommands.0" },
    ]);
  });
});

// --- ensureTemplate ---

type Latest = Awaited<ReturnType<TemplateBuilds["latest"]>>;

/** A scripted TemplateBuilds: `latest` answers from a queue (the last
 *  answer repeats), `start` from a queue of build ids or errors, and
 *  `settle` from a map of build id → final state. */
function scripted(script: {
  latest: Latest[];
  starts?: (string | Error)[];
  settles?: Record<string, BuildState>;
}) {
  const latest = [...script.latest];
  const starts = [...(script.starts ?? [])];
  const builds = {
    latest: vi.fn(async () => (latest.length > 1 ? latest.shift() : latest[0])),
    start: vi.fn(async () => {
      const next = starts.shift();
      if (next === undefined) throw new Error("unexpected start");
      if (next instanceof Error) throw next;
      return { templateId: "tpl", buildId: next };
    }),
    settle: vi.fn(async ({ buildId }: { buildId: string }) => {
      const state = script.settles?.[buildId];
      if (!state) throw new Error(`unexpected settle of ${buildId}`);
      return state;
    }),
  } satisfies TemplateBuilds;
  return builds;
}

const build = (buildId: string, status: BuildState["status"]): Latest => ({
  templateId: "tpl",
  buildId,
  status,
});

const NAME = "funky-pkgs-test";
const STEPS: BuildStep[] = [
  { command: "pip install 'numpy'", user: "root", label: "package install" },
  {
    command: "monid keys add --key monid_x_y --label funky",
    user: "user",
    label: "setupCommands.0",
  },
];
/** A build that ended in error on step `step` (1-based, as E2B says). */
const failedAt = (step: string): BuildState => ({
  status: "error",
  reason: { message: "failed to run command: exit status 1", step },
});

describe("ensureTemplate", () => {
  test("a ready build is enough — nothing started", async () => {
    const builds = scripted({ latest: [build("b1", "ready")] });
    await ensureTemplate(builds, NAME, STEPS);
    expect(builds.start).not.toHaveBeenCalled();
  });

  test("waits on a build already in flight instead of starting a rival", async () => {
    const builds = scripted({
      latest: [build("theirs", "building")],
      settles: { theirs: { status: "ready" } },
    });
    await ensureTemplate(builds, NAME, STEPS);
    expect(builds.settle).toHaveBeenCalledWith(expect.objectContaining({ buildId: "theirs" }));
    expect(builds.start).not.toHaveBeenCalled();
  });

  test("builds a template that was never built", async () => {
    const builds = scripted({
      latest: [undefined],
      starts: ["ours"],
      settles: { ours: { status: "ready" } },
    });
    await ensureTemplate(builds, NAME, STEPS);
    expect(builds.start).toHaveBeenCalledWith(NAME, STEPS);
  });

  test("our own failed install is permanent", async () => {
    const builds = scripted({
      latest: [undefined],
      starts: ["ours"],
      settles: {
        ours: {
          status: "error",
          reason: {
            message: "failed to run command 'pip install 'nope==99'': exit status 1",
            step: "1",
          },
        },
      },
    });
    const ensured = ensureTemplate(builds, NAME, STEPS);
    await expect(ensured).rejects.toBeInstanceOf(SandboxProvisionError);
    await expect(ensured).rejects.toThrow("package install failed: failed to run command");
  });

  test("a failed setup command is permanent, and named by its place in the config", async () => {
    const builds = scripted({
      latest: [undefined],
      starts: ["ours"],
      settles: { ours: failedAt("2") },
    });
    const ensured = ensureTemplate(builds, NAME, STEPS);
    await expect(ensured).rejects.toBeInstanceOf(SandboxProvisionError);
    await expect(ensured).rejects.toThrow(
      "setupCommands.0 failed: failed to run command: exit status 1",
    );
  });

  test("a failed step it can't place is still permanent, by E2B's number", async () => {
    const builds = scripted({
      latest: [undefined],
      starts: ["ours"],
      settles: { ours: failedAt("7") },
    });
    const ensured = ensureTemplate(builds, NAME, STEPS);
    await expect(ensured).rejects.toBeInstanceOf(SandboxProvisionError);
    await expect(ensured).rejects.toThrow("build step 7 failed: failed to run command");
  });

  test("a start that collides waits on the build that won", async () => {
    const builds = scripted({
      latest: [undefined, build("winner", "building")],
      starts: [new Error("500: duplicate key value violates unique constraint")],
      settles: { winner: { status: "ready" } },
    });
    await ensureTemplate(builds, NAME, STEPS);
    expect(builds.start).toHaveBeenCalledTimes(1);
  });

  test("a build cancelled by a newer one waits on the newer one", async () => {
    const builds = scripted({
      latest: [undefined, build("newer", "building")],
      starts: ["ours"],
      settles: {
        ours: { status: "error", reason: { message: "build was cancelled" } },
        newer: { status: "ready" },
      },
    });
    await ensureTemplate(builds, NAME, STEPS);
    expect(builds.start).toHaveBeenCalledTimes(1);
  });

  test("an in-flight build that fails is looked at again, then rebuilt", async () => {
    const builds = scripted({
      latest: [build("theirs", "building"), build("theirs", "error")],
      starts: ["ours"],
      settles: {
        theirs: { status: "error", reason: { message: "boom", step: "1" } },
        ours: { status: "ready" },
      },
    });
    await ensureTemplate(builds, NAME, STEPS);
    expect(builds.start).toHaveBeenCalledTimes(1);
  });

  test("an earlier session's failed build is retried, not remembered", async () => {
    const builds = scripted({
      latest: [build("old", "error")],
      starts: ["ours"],
      settles: { ours: { status: "ready" } },
    });
    await ensureTemplate(builds, NAME, STEPS);
    expect(builds.start).toHaveBeenCalledTimes(1);
  });

  test("collisions are not retried forever — the last error propagates untyped", async () => {
    const collision = new Error("400: build is not in waiting state");
    const builds = scripted({ latest: [undefined], starts: Array(10).fill(collision) });
    const ensured = ensureTemplate(builds, NAME, STEPS);
    await expect(ensured).rejects.toBe(collision);
    expect(builds.start).toHaveBeenCalledTimes(5);
  });
});
