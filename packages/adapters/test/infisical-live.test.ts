// The Infisical adapter against a real Infisical: the conformance suite,
// where infisical.test.ts runs it against a fake. Runs only when
// INFISICAL_CLIENT_ID is set — a machine identity with Universal Auth,
// a member of the project:
//
//   INFISICAL_SITE_URL=http://localhost:8080 \
//   INFISICAL_CLIENT_ID=... INFISICAL_CLIENT_SECRET=... \
//   INFISICAL_PROJECT_ID=... INFISICAL_ENVIRONMENT=dev \
//     pnpm --filter @funky/adapters test infisical-live
//
// INFISICAL_SITE_URL defaults to Infisical Cloud (US). A self-hosted one
// from Infisical's docker compose works as well. Everything the run
// writes goes under a folder of its own, force-deleted at the end.

import { randomUUID } from "node:crypto";
import { afterAll, describe, it } from "vitest";
import { createInfisicalSecretProvider } from "../src/secrets/infisical";
import { describeSecretProviderConformance } from "./secret-provider-conformance";

const clientId = process.env.INFISICAL_CLIENT_ID;

if (!clientId) {
  describe.skip("infisical secret provider (live)", () => {
    it("skipped — set INFISICAL_CLIENT_ID to run", () => {});
  });
} else {
  const siteUrl = process.env.INFISICAL_SITE_URL || "https://app.infisical.com";
  const options = {
    siteUrl,
    clientId,
    clientSecret: required("INFISICAL_CLIENT_SECRET"),
    projectId: required("INFISICAL_PROJECT_ID"),
    environment: required("INFISICAL_ENVIRONMENT"),
    path: `/funky-live-${randomUUID()}`,
  };

  describeSecretProviderConformance("infisical (live)", async () =>
    createInfisicalSecretProvider(options),
  );

  afterAll(async () => {
    const login = await fetch(`${siteUrl}/api/v1/auth/universal-auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientId, clientSecret: options.clientSecret }),
    });
    const { accessToken } = (await login.json()) as { accessToken: string };
    await fetch(`${siteUrl}/api/v2/folders/${options.path.slice(1)}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        projectId: options.projectId,
        environment: options.environment,
        path: "/",
        forceDelete: true,
      }),
    });
  }, 60_000);
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set with INFISICAL_CLIENT_ID`);
  return value;
}
