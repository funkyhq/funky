// Agent-config packages and setup commands against real E2B: template
// builds, and what a mock cannot vouch for — that every package is usable
// where the agent runs (the sandbox's default user, at the workspace
// root), that two sessions asking at once share one template instead of
// failing on the build collision, that setup commands run as that user,
// each in its own shell, and leave their files to every sandbox, and that
// a spec which does not install or a setup command that fails surfaces
// as SandboxProvisionError. Runs only when E2B_API_KEY is set; every run
// deletes and rebuilds its templates, so expect minutes:
//
//   E2B_API_KEY=... pnpm --filter @funky/adapters test e2b-packages-live

import { afterAll, beforeAll, describe, expect, it, test } from "vitest";
import { ApiClient, ConnectionConfig } from "e2b";
import type { Packages, SetupCommands } from "@funky/core";
import { type Sandbox, SandboxProvisionError, type SandboxProvider } from "@funky/agent";
import { createE2bProvider } from "../src/sandbox/e2b";
import { canonicalPackages, templateName } from "../src/sandbox/e2b-packages";

const apiKey = process.env.E2B_API_KEY;

// One spec per manager, none of them in the base template (probed), and
// specs the shell would mangle unquoted (">=", "@").
const USABLE: Packages = {
  apt: ["figlet"],
  npm: ["left-pad@1.3.0"],
  pip: ["cowsay>=6"],
};
const BROKEN: Packages = { pip: ["funky-definitely-not-a-package==99"] };
// No packages: setup alone builds a template. A stand-in key the way a
// CLI's `keys add` would store it, written by a heredoc, and a `cd` that
// must not reach the next command.
const SETUP: SetupCommands = [
  "mkdir -p ~/.config/funky-probe && cat > ~/.config/funky-probe/keys.yaml <<'EOF'\nkey: stand-in\nEOF",
  "cd /tmp",
  "pwd > ~/setup-pwd",
];
const BROKEN_SETUP: SetupCommands = ["true", "exit 3"];

/** Deletes a build's template if it exists, so the run builds it. */
async function deleteTemplate(packages: Packages, setup: SetupCommands = []): Promise<void> {
  const api = new ApiClient(new ConnectionConfig({ apiKey })).api;
  const alias = await api.GET("/templates/aliases/{alias}", {
    params: { path: { alias: templateName(canonicalPackages(packages), setup) } },
  });
  if (!alias.data) return;
  await api.DELETE("/templates/{templateID}", {
    params: { path: { templateID: alias.data.templateID } },
  });
}

if (!apiKey) {
  describe.skip("e2b package templates (live)", () => {
    it("skipped — set E2B_API_KEY to run", () => {});
  });
} else {
  describe("e2b package templates (live)", () => {
    let provider: SandboxProvider;
    const sandboxes: Sandbox[] = [];
    const create = (packages: Packages, setupCommands?: SetupCommands) =>
      provider.create({ packages, setupCommands, timeoutMs: 300_000, lifecycle: "kill" });
    const templates = (): Promise<void[]> =>
      Promise.all([
        deleteTemplate(USABLE),
        deleteTemplate(BROKEN),
        deleteTemplate({}, SETUP),
        deleteTemplate({}, BROKEN_SETUP),
      ]);

    beforeAll(async () => {
      provider = createE2bProvider({ apiKey });
      await templates();
    }, 60_000);

    afterAll(async () => {
      await Promise.all(sandboxes.map((sandbox) => sandbox.kill().catch(() => {})));
      await templates();
    }, 60_000);

    test("two sessions asking at once share one build, and every package is usable", async () => {
      const [a, b] = await Promise.all([create(USABLE), create(USABLE)]);
      sandboxes.push(a, b);

      for (const sandbox of [a, b]) {
        const where = await sandbox.run("whoami; pwd");
        expect(where.stdout.split("\n").slice(0, 2)).toEqual(["user", "/home/user"]);

        const apt = await sandbox.run("figlet -v");
        expect(apt.exitCode).toBe(0);

        const npm = await sandbox.run(`node -e "console.log(require('left-pad')('x', 3))"`);
        expect(npm).toMatchObject({ exitCode: 0, stdout: "  x\n" });

        const pip = await sandbox.run(
          `python3 -c "import cowsay, importlib.metadata as m; print(m.version('cowsay'))"`,
        );
        expect(pip.exitCode).toBe(0);
        expect(Number(pip.stdout.split(".")[0])).toBeGreaterThanOrEqual(6); // ">=" reached pip
      }
    }, 600_000);

    test("a spec that does not install rejects as SandboxProvisionError", async () => {
      await expect(create(BROKEN)).rejects.toBeInstanceOf(SandboxProvisionError);
    }, 600_000);

    test("setup runs once, as the sandbox's user, and every sandbox starts with it", async () => {
      const first = await create({}, SETUP);
      sandboxes.push(first);
      const second = await create({}, SETUP); // the build is reused
      sandboxes.push(second);

      for (const sandbox of [first, second]) {
        const keys = await sandbox.run(
          "stat -c %U ~/.config/funky-probe/keys.yaml && cat ~/.config/funky-probe/keys.yaml",
        );
        expect(keys).toMatchObject({ exitCode: 0, stdout: "user\nkey: stand-in\n" });
        // Each command had its own shell: the `cd /tmp` didn't carry.
        expect((await sandbox.run("cat ~/setup-pwd")).stdout).toBe("/home/user\n");
      }
    }, 600_000);

    test("a setup command that fails rejects as SandboxProvisionError, naming it", async () => {
      const created = create({}, BROKEN_SETUP);
      await expect(created).rejects.toBeInstanceOf(SandboxProvisionError);
      await expect(created).rejects.toThrow(/^setupCommands\.1 failed: /);
    }, 600_000);
  });
}
