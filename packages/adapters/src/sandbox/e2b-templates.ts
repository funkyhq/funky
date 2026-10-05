// The TemplateBuilder port over E2B templates. `start` is the SDK's
// `Template.buildInBackground`: two API calls, one to register the build
// and one to hand it the instructions, after which E2B runs the build on
// its own. `status` is one `Template.getBuildStatus`. Every start names a
// fresh template (`funky-<uuid>`), so nothing is ever rebuilt in place.
//
// The template layers the packages over "base", the template every
// sandbox boots from today (createE2bProvider passes none), so a session
// on it differs from one without packages by the packages alone.
// Managers install in a fixed order, apt first, because a language
// package may build against a system library. Each one runs as the user
// that makes its packages usable from the workspace:
// - apt and pip install system-wide as root, so packages import from any
//   directory;
// - npm installs as `user` into /home/user, the workspace root, so
//   `require` resolves from anywhere under it.
//
// Specs are shell-quoted here. The SDK's pipInstall/npmInstall join specs
// into the command unquoted, where "pandas>=2" would be a redirect.

import { randomUUID } from "node:crypto";
import { Template, type TemplateBuilder as E2bTemplateBuilder } from "e2b";
import type { Packages } from "@funky/core";
import {
  type TemplateBuilder,
  type TemplateBuildRef,
  type TemplateBuildStatus,
  UnsupportedPackagesError,
} from "@funky/agent";

export interface E2bTemplateBuilderOptions {
  /** Defaults to the E2B_API_KEY environment variable. */
  apiKey?: string;
}

/** One manager's install, as a shell command and the user it runs as. */
export interface InstallStep {
  command: string;
  user: "root" | "user";
}

// Insertion order is install order.
const INSTALLERS: Record<string, (specs: string) => InstallStep> = {
  apt: (specs) => ({
    command: `apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y ${specs}`,
    user: "root",
  }),
  npm: (specs) => ({ command: `cd /home/user && npm install ${specs}`, user: "user" }),
  pip: (specs) => ({ command: `pip install ${specs}`, user: "root" }),
};

/**
 * The install steps a recipe needs, in install order. A manager listed
 * with no specs installs nothing and is skipped; one with specs that has
 * no installer rejects the whole recipe.
 */
export function installSteps(packages: Packages): InstallStep[] {
  const unsupported = Object.keys(packages).filter(
    (manager) => packages[manager]!.length > 0 && !Object.hasOwn(INSTALLERS, manager),
  );
  if (unsupported.length > 0) {
    throw new UnsupportedPackagesError(
      `unsupported package manager(s): ${unsupported.join(", ")} ` +
        `(supported: ${Object.keys(INSTALLERS).join(", ")})`,
    );
  }
  return Object.entries(INSTALLERS).flatMap(([manager, install]) => {
    const specs = packages[manager] ?? [];
    return specs.length === 0 ? [] : [install(specs.map(shellQuote).join(" "))];
  });
}

export function createE2bTemplateBuilder(options?: E2bTemplateBuilderOptions): TemplateBuilder {
  const connection = { apiKey: options?.apiKey };

  return {
    async start(packages: Packages): Promise<TemplateBuildRef> {
      // Steps first: an unsupported manager rejects before E2B hears of it.
      let template: E2bTemplateBuilder = Template().fromTemplate("base");
      for (const step of installSteps(packages)) {
        template = template.runCmd(step.command, { user: step.user });
      }
      const info = await Template.buildInBackground(template, `funky-${randomUUID()}`, connection);
      return { templateId: info.templateId, buildId: info.buildId };
    },

    async status(ref: TemplateBuildRef): Promise<TemplateBuildStatus> {
      const build = await Template.getBuildStatus(ref, connection);
      switch (build.status) {
        case "ready":
          return { status: "ready" };
        case "error":
          return { status: "failed", error: describeFailure(build.reason) };
        default:
          // "waiting" is queued behind E2B's build capacity; still building.
          return { status: "building" };
      }
    },
  };
}

/** E2B's reason, plus the log lines it ties to the failure — where a
 *  package manager says which spec it could not install. */
function describeFailure(reason?: { message: string; logEntries: { message: string }[] }): string {
  if (reason === undefined) return "template build failed";
  const logs = reason.logEntries.slice(-10).map((entry) => entry.message);
  return [reason.message, ...logs].join("\n");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
