// The e2b template builder against real E2B builds — what the mocked
// suite can only assert by fiat: that "base" layers, that each manager's
// install runs as the user it needs, that a sandbox booted from the
// template finds the packages, and what a failed build reports. Runs
// only when E2B_API_KEY is set (deliberate opt-in — every run builds two
// real templates, minutes each):
//
//   E2B_API_KEY=... pnpm --filter @funky/adapters test e2b-templates-live
//
// Each template is deleted when its test ends; the sandbox's TTL is
// lifecycle "kill" so an aborted run leaves no running orphan.

import { afterAll, describe, expect, it, test } from "vitest";
import { Sandbox } from "e2b";
import type { TemplateBuilder, TemplateBuildRef, TemplateBuildStatus } from "@funky/agent";
import { createE2bTemplateBuilder } from "../src/sandbox/e2b-templates";

const apiKey = process.env.E2B_API_KEY;
const BUILD_BUDGET_MS = 10 * 60_000;

/** Poll until the build leaves "building", as the api's reads would. */
async function settled(builder: TemplateBuilder, ref: TemplateBuildRef) {
  const deadline = Date.now() + BUILD_BUDGET_MS;
  let status: TemplateBuildStatus = { status: "building" };
  while (status.status === "building" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    status = await builder.status(ref);
  }
  return status;
}

if (!apiKey) {
  describe.skip("e2b template builder (live)", () => {
    it("skipped — set E2B_API_KEY to run", () => {});
  });
} else {
  describe("e2b template builder (live)", () => {
    const builder = createE2bTemplateBuilder({ apiKey });
    const built: string[] = [];

    afterAll(async () => {
      for (const templateId of built) {
        await Sandbox.deleteSnapshot(templateId, { apiKey }).catch(() => {});
      }
    }, 60_000);

    test(
      "builds the packages into a template a sandbox boots with",
      async () => {
        const ref = await builder.start({ pip: ["six==1.16.0"], npm: ["left-pad@1.3.0"] });
        built.push(ref.templateId);
        expect(await settled(builder, ref)).toEqual({ status: "ready" });

        const sandbox = await Sandbox.create(ref.templateId, {
          apiKey,
          timeoutMs: 120_000,
          lifecycle: { onTimeout: "kill" },
        });
        try {
          const python = await sandbox.commands.run(
            `python3 -c "import six; print(six.__version__)"`,
          );
          expect(python.stdout.trim()).toBe("1.16.0");

          // From a subdirectory of the workspace, as an agent's script would be.
          const node = await sandbox.commands.run(
            `mkdir -p /home/user/app && cd /home/user/app && ` +
              `node -e "console.log(JSON.stringify(require('left-pad')('x', 3)))"`,
          );
          expect(node.stdout.trim()).toBe(JSON.stringify("  x"));
        } finally {
          await sandbox.kill().catch(() => {});
        }
      },
      BUILD_BUDGET_MS + 120_000,
    );

    test(
      "a spec no registry has fails the build, in the installer's words",
      async () => {
        const missing = `funky-no-such-package-${Date.now()}`;
        const ref = await builder.start({ pip: [missing] });
        built.push(ref.templateId);

        const status = await settled(builder, ref);
        expect(status.status).toBe("failed");
        expect(status.error).toContain(missing);
      },
      BUILD_BUDGET_MS + 60_000,
    );
  });
}
