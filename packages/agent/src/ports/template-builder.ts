// The TemplateBuilder port
//
// Bakes an env config's packages into a sandbox template on the
// provider, so a sandbox booted from it starts with them installed
// rather than installing on every create. The api calls it when an env
// config write changes the packages (core/store.ts TemplateBuild); the
// session side — booting from the template — is not wired yet.
//
// Contract for implementations:
// - `start` resolves once the provider has ACCEPTED the build (seconds)
//   and never waits for it to finish. A build takes minutes and runs on
//   the provider, so no funky process holds it; `status` follows it.
// - Every `start` is a new template. Nothing is rebuilt in place, so a
//   templateId always names exactly the packages it was started with.
// - A package manager the implementation cannot install is rejected by
//   `start` with UnsupportedPackagesError before anything reaches the
//   provider — never skipped, never half-installed.
// - `status` is a read: "building" until the provider settles the build,
//   then "ready" or "failed" with the provider's reason. Both are final.

import type { Packages, TemplateBuild } from "@funky/core";

/** `start`'s rejection of a recipe naming a manager it cannot install —
 *  the caller's mistake (the api's 400), not a provider failure. */
export class UnsupportedPackagesError extends Error {}

/** What identifies one build on the provider. */
export type TemplateBuildRef = Pick<TemplateBuild, "templateId" | "buildId">;

/** Where a build stands; `error` only on "failed". */
export type TemplateBuildStatus = Pick<TemplateBuild, "status" | "error">;

export interface TemplateBuilder {
  /** Start building a new template with `packages` installed. */
  start(packages: Packages): Promise<TemplateBuildRef>;
  /** Read where a started build stands. */
  status(ref: TemplateBuildRef): Promise<TemplateBuildStatus>;
}
