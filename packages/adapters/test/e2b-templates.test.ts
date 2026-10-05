// The e2b template builder's translation layer, pinned against a mocked
// SDK: the install steps a recipe becomes (order, users, quoting), the
// refusal of a manager it has no installer for before E2B is called, a
// fresh template name per start, and the build-status mapping. The real
// build is exercised by the key-gated live suite in e2b-live.test.ts.

import { beforeEach, describe, expect, test, vi } from "vitest";
import { UnsupportedPackagesError } from "@funky/agent";
import { createE2bTemplateBuilder, installSteps } from "../src/sandbox/e2b-templates";

const mocks = vi.hoisted(() => {
  /** What the builder chain was asked for, in order. */
  const recorded: { from?: string; steps: { command: string; user?: string }[] } = { steps: [] };
  const chain = {
    fromTemplate(template: string) {
      recorded.from = template;
      return chain;
    },
    runCmd(command: string, options?: { user?: string }) {
      recorded.steps.push({ command, user: options?.user });
      return chain;
    },
  };
  return {
    recorded,
    Template: Object.assign(() => chain, {
      buildInBackground: vi.fn(),
      getBuildStatus: vi.fn(),
    }),
  };
});

vi.mock("e2b", () => ({ Template: mocks.Template }));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.recorded.from = undefined;
  mocks.recorded.steps = [];
});

describe("installSteps", () => {
  test("installs apt, then npm, then pip, whatever order the recipe lists them in", () => {
    const steps = installSteps({
      pip: ["pandas==2.2.0"],
      npm: ["express@4.18.0"],
      apt: ["graphviz"],
    });
    expect(steps).toEqual([
      {
        command: "apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y 'graphviz'",
        user: "root",
      },
      { command: "cd /home/user && npm install 'express@4.18.0'", user: "user" },
      { command: "pip install 'pandas==2.2.0'", user: "root" },
    ]);
  });

  test("quotes every spec, so shell syntax in one stays part of the spec", () => {
    const [step] = installSteps({ pip: ["pandas>=2", "it's; rm -rf /"] });
    expect(step?.command).toBe(`pip install 'pandas>=2' 'it'\\''s; rm -rf /'`);
  });

  test("skips a manager listed with no specs, even one it has no installer for", () => {
    expect(installSteps({ pip: ["numpy"], npm: [], cargo: [] })).toEqual([
      { command: "pip install 'numpy'", user: "root" },
    ]);
  });

  test("rejects a manager with specs and no installer, naming it", () => {
    expect(() => installSteps({ pip: ["numpy"], cargo: ["ripgrep"], gem: ["rails"] })).toThrow(
      UnsupportedPackagesError,
    );
    expect(() => installSteps({ cargo: ["ripgrep"] })).toThrow(/cargo.*supported: apt, npm, pip/);
  });
});

describe("createE2bTemplateBuilder", () => {
  test("start layers the steps over base and returns E2B's ids", async () => {
    mocks.Template.buildInBackground.mockResolvedValue({
      name: "funky-x",
      templateId: "tpl_1",
      buildId: "bld_1",
    });
    const builder = createE2bTemplateBuilder({ apiKey: "k" });

    const ref = await builder.start({ pip: ["numpy"] });
    expect(ref).toEqual({ templateId: "tpl_1", buildId: "bld_1" });
    expect(mocks.recorded.from).toBe("base");
    expect(mocks.recorded.steps).toEqual([{ command: "pip install 'numpy'", user: "root" }]);
    expect(mocks.Template.buildInBackground).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringMatching(/^funky-[0-9a-f-]{36}$/),
      { apiKey: "k" },
    );
  });

  test("start names a fresh template every time — nothing is rebuilt in place", async () => {
    mocks.Template.buildInBackground.mockResolvedValue({ templateId: "t", buildId: "b" });
    const builder = createE2bTemplateBuilder();
    await builder.start({ pip: ["numpy"] });
    await builder.start({ pip: ["numpy"] });
    const [first, second] = mocks.Template.buildInBackground.mock.calls.map((call) => call[1]);
    expect(first).not.toBe(second);
  });

  test("start refuses an unsupported manager before reaching E2B", async () => {
    const builder = createE2bTemplateBuilder();
    await expect(builder.start({ cargo: ["ripgrep"] })).rejects.toBeInstanceOf(
      UnsupportedPackagesError,
    );
    expect(mocks.Template.buildInBackground).not.toHaveBeenCalled();
  });

  test("status maps E2B's four states onto building, ready, failed", async () => {
    const builder = createE2bTemplateBuilder({ apiKey: "k" });
    const ref = { templateId: "tpl_1", buildId: "bld_1" };

    for (const status of ["building", "waiting"]) {
      mocks.Template.getBuildStatus.mockResolvedValueOnce({ status, logEntries: [] });
      expect(await builder.status(ref)).toEqual({ status: "building" });
    }
    mocks.Template.getBuildStatus.mockResolvedValueOnce({ status: "ready", logEntries: [] });
    expect(await builder.status(ref)).toEqual({ status: "ready" });
    expect(mocks.Template.getBuildStatus).toHaveBeenCalledWith(ref, { apiKey: "k" });
  });

  test("a failed build carries E2B's reason and the log lines tied to it", async () => {
    mocks.Template.getBuildStatus.mockResolvedValue({
      status: "error",
      logEntries: [],
      reason: {
        message: "command failed",
        logEntries: [{ message: "ERROR: No matching distribution found for nmupy" }],
      },
    });
    const result = await createE2bTemplateBuilder().status({ templateId: "t", buildId: "b" });
    expect(result).toEqual({
      status: "failed",
      error: "command failed\nERROR: No matching distribution found for nmupy",
    });
  });

  test("a failed build without a reason still says it failed", async () => {
    mocks.Template.getBuildStatus.mockResolvedValue({ status: "error", logEntries: [] });
    const result = await createE2bTemplateBuilder().status({ templateId: "t", buildId: "b" });
    expect(result).toEqual({ status: "failed", error: "template build failed" });
  });
});
