// Agent-config packages and setup commands on E2B: one template per
// distinct package set and setup list, built on first use and shared by
// every session that asks for the same pair — across namespaces, which
// is safe exactly because the template's name hashes every input of its
// build (the specs, the setup commands, the base template, the recipe
// version). Anything else that ever shapes a build — a private index, a
// credential — must join the hash, or the cache must become
// per-namespace.
//
// The hash names the request, not the resolved versions: an unpinned
// spec ("pandas") resolves once, at the first build, and every later
// session gets that same build until the specs or RECIPE_VERSION change.
// So does whatever a setup command fetches.
//
// Packages install as root; setup commands then run as `user`, the
// sandbox's default user that every later command runs as, so what they
// write lands in its home (/home/user, the build's working directory for
// that user; probed).
//
// What E2B does with same-name builds (probed live, 2026-10-19) shapes
// ensureTemplate:
// - Template.exists is true from a build's first second and stays true
//   after it fails, so it cannot say "ready". The create's 404 can
//   (e2b.ts): only a successful build tags the template.
// - Simultaneous first builds collide: one is accepted, the rest fail to
//   start (500 duplicate alias, 400 "not in waiting state").
// - A build started while another runs is accepted and CANCELS the
//   running one. So a worker must wait on an in-flight build, never
//   start a second — a naive build-on-404 lets staggered sessions cancel
//   each other's builds forever.

import { createHash } from "node:crypto";
import { ApiClient, ConnectionConfig, Template } from "e2b";
import type { Packages, SetupCommands } from "@funky/core";
import { SandboxProvisionError } from "@funky/agent";

/** Bump when the recipe below changes how an image is built: every
 *  package set then rebuilds instead of reusing an image built the old
 *  way. */
const RECIPE_VERSION = 1;

/** The E2B template every package image builds on — the same one a
 *  sandbox with no packages starts from. */
export const BASE_TEMPLATE = "base";

/** `npm root -g` in BASE_TEMPLATE (probed). Global installs land here,
 *  and require() only finds them through NODE_PATH, which the template
 *  cannot set for runtime commands — the create does (e2b.ts). */
export const NPM_GLOBAL_ROOT = "/usr/local/lib/node_modules";

/** One install command per manager, run as root in manager order. The
 *  specs are shell-quoted here because E2B's own pipInstall/npmInstall/
 *  aptInstall join them unquoted: "pandas>=2.0" would redirect. */
const INSTALLERS: Record<string, (specs: string) => string> = {
  apt: (specs) => `apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y ${specs}`,
  npm: (specs) => `npm install -g ${specs}`,
  pip: (specs) => `pip install ${specs}`,
};

/** A package set in one canonical form: managers sorted (apt sorts
 *  first, so system libraries land before the language packages that
 *  need them), each manager's specs sorted and deduplicated, empty
 *  managers dropped. Equal sets give equal forms, whatever order they
 *  were written in. */
export type CanonicalPackages = [manager: string, specs: string[]][];

export function canonicalPackages(packages: Packages): CanonicalPackages {
  return Object.entries(packages)
    .map(([manager, specs]): [string, string[]] => [manager, [...new Set(specs)].sort()])
    .filter(([, specs]) => specs.length > 0)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Rejects a manager this adapter cannot install — before anything is
 *  built or created. */
export function assertInstallable(canonical: CanonicalPackages): void {
  const unsupported = canonical.map(([manager]) => manager).filter((m) => !(m in INSTALLERS));
  if (unsupported.length > 0) {
    throw new SandboxProvisionError(
      `the E2B sandbox provider cannot install ${unsupported.join(", ")} packages ` +
        `(it installs: ${Object.keys(INSTALLERS).sort().join(", ")})`,
    );
  }
}

/** The template a package set and setup list build into, named by the
 *  hash of everything that shapes the build. Setup joins the hash only
 *  when there is some, so a package set without it keeps the name — and
 *  the build — it had before setup commands existed. Setup is never
 *  canonicalized: its order is the order it runs in. */
export function templateName(canonical: CanonicalPackages, setup: SetupCommands = []): string {
  const inputs = {
    recipe: RECIPE_VERSION,
    base: BASE_TEMPLATE,
    packages: canonical,
    ...(setup.length > 0 ? { setup } : {}),
  };
  const hash = createHash("sha256").update(JSON.stringify(inputs)).digest("hex");
  return `funky-pkgs-${hash.slice(0, 24)}`;
}

/** One command of a build, the user it runs as, and what to call it when
 *  it fails. */
export interface BuildStep {
  command: string;
  user: "root" | "user";
  label: string;
}

/** The build's steps, in order: the installs, then the setup. */
export function buildSteps(canonical: CanonicalPackages, setup: SetupCommands = []): BuildStep[] {
  const installs = canonical.map(([manager, specs]): BuildStep => {
    const install = INSTALLERS[manager];
    if (!install) throw new Error(`no installer for ${manager}`); // assertInstallable's job
    return {
      command: install(specs.map(shellQuote).join(" ")),
      user: "root",
      label: "package install",
    };
  });
  const setups = setup.map((command, i): BuildStep => ({
    command,
    user: "user",
    label: `setupCommands.${i}`,
  }));
  return [...installs, ...setups];
}

/** POSIX single-quoting: everything literal, an embedded ' closed,
 *  escaped, and reopened. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export interface BuildRef {
  templateId: string;
  buildId: string;
}

export interface BuildState {
  status: "building" | "waiting" | "ready" | "error";
  /** Why a build ended in error. `step` is set when one of the recipe's
   *  own commands failed — its 1-based position among the steps
   *  (probed) — and a cancelled build has none. */
  reason?: { message: string; step?: string };
}

/** The slice of E2B's template API ensureTemplate needs — narrow, so
 *  its state machine is testable without the SDK. */
export interface TemplateBuilds {
  /** The template's newest build, or undefined if it was never built. */
  latest(name: string): Promise<(BuildRef & BuildState) | undefined>;
  /** Start a build. Rejects when the start collides with another. */
  start(name: string, steps: BuildStep[]): Promise<BuildRef>;
  /** Resolves once the build is ready or in error. */
  settle(build: BuildRef): Promise<BuildState>;
}

/** Collisions are retried, but not forever: past this many rounds the
 *  last error propagates as a transient failure. */
const MAX_ROUNDS = 5;

/**
 * Make sure the template has a ready build — waiting on one already in
 * flight rather than starting a rival, since a second build would cancel
 * it. Called after a create found the template unready. Only a build of
 * our own failing on its own command is permanent (SandboxProvisionError);
 * a collision or a cancellation means another worker is building, so the
 * next round waits on that build instead. A previous session's failed
 * build is retried, not remembered: the next session may get past what
 * was only a registry hiccup.
 */
export async function ensureTemplate(
  builds: TemplateBuilds,
  name: string,
  steps: BuildStep[],
): Promise<void> {
  let lastError: unknown;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const latest = await builds.latest(name);
    if (latest?.status === "ready") return;
    if (latest?.status === "building" || latest?.status === "waiting") {
      if ((await builds.settle(latest)).status === "ready") return;
      continue; // failed or cancelled: look again — another build may be running
    }
    let ours: BuildRef;
    try {
      ours = await builds.start(name, steps);
    } catch (error) {
      lastError = error; // collided with another worker's start: wait on theirs
      continue;
    }
    const state = await builds.settle(ours);
    if (state.status === "ready") return;
    if (state.reason?.step !== undefined) {
      const failed =
        steps[Number(state.reason.step) - 1]?.label ?? `build step ${state.reason.step}`;
      throw new SandboxProvisionError(`${failed} failed: ${state.reason.message}`);
    }
    lastError = new Error(`template build ${ours.buildId}: ${state.reason?.message ?? "error"}`);
    // Cancelled — superseded by another worker's build; wait on that one.
  }
  throw lastError ?? new Error(`template ${name}: no ready build after ${MAX_ROUNDS} rounds`);
}

/** How often a waiting worker polls a build's status. */
const POLL_MS = 2_000;

/** TemplateBuilds over E2B's API. `latest` goes to REST — the SDK has no
 *  call that lists a template's builds — through the SDK's own client,
 *  so the connection (key, domain) is the same one every call uses. */
export function e2bTemplateBuilds(connection: { apiKey?: string }): TemplateBuilds {
  const api = (): ApiClient["api"] => new ApiClient(new ConnectionConfig(connection)).api;
  return {
    async latest(name) {
      const alias = await api().GET("/templates/aliases/{alias}", {
        params: { path: { alias: name } },
      });
      if (alias.response.status === 404) return undefined;
      if (!alias.data) {
        throw new Error(`template ${name}: alias lookup failed (${alias.response.status})`);
      }
      const templateId = alias.data.templateID;
      const template = await api().GET("/templates/{templateID}", {
        params: { path: { templateID: templateId } },
      });
      if (!template.data) {
        throw new Error(`template ${name}: build listing failed (${template.response.status})`);
      }
      let newest: (typeof template.data.builds)[number] | undefined;
      for (const build of template.data.builds) {
        if (!newest || Date.parse(build.createdAt) > Date.parse(newest.createdAt)) newest = build;
      }
      return newest && { templateId, buildId: newest.buildID, status: newest.status };
    },

    async start(name, steps) {
      let template = Template().fromTemplate(BASE_TEMPLATE);
      for (const { command, user } of steps) template = template.runCmd(command, { user });
      const { templateId, buildId } = await Template.buildInBackground(template, name, connection);
      return { templateId, buildId };
    },

    async settle(build) {
      for (;;) {
        const { status, reason } = await Template.getBuildStatus(build, connection);
        if (status === "ready" || status === "error") {
          return { status, reason: reason && { message: reason.message, step: reason.step } };
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      }
    },
  };
}
