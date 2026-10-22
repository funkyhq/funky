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
//
// Infisical Cloud's free plan allows an IP 120 secrets requests a minute,
// and the suite sends about 160, so the run holds itself to 100 a minute:
// about two minutes against Cloud.

import { randomUUID } from "node:crypto";
import { afterAll, describe, it, vi } from "vitest";
import { createInfisicalSecretProvider } from "../src/secrets/infisical";
import { describeSecretProviderConformance } from "./secret-provider-conformance";

const clientId = process.env.INFISICAL_CLIENT_ID;

if (!clientId) {
  describe.skip("infisical secret provider (live)", () => {
    it("skipped — set INFISICAL_CLIENT_ID to run", () => {});
  });
} else {
  // A test may wait out the minute's budget.
  vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
  const siteUrl = process.env.INFISICAL_SITE_URL || "https://app.infisical.com";
  const options = {
    siteUrl,
    clientId,
    clientSecret: required("INFISICAL_CLIENT_SECRET"),
    projectId: required("INFISICAL_PROJECT_ID"),
    environment: required("INFISICAL_ENVIRONMENT"),
    path: `/funky-live-${randomUUID()}`,
    fetch: paced(100),
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

/** fetch, sending at most `perMinute` requests in any 60 seconds. */
function paced(perMinute: number): typeof fetch {
  const sent: number[] = [];
  return async (input, init) => {
    for (;;) {
      const now = Date.now();
      while (sent.length > 0 && sent[0]! <= now - 60_000) sent.shift();
      if (sent.length < perMinute) break;
      await new Promise((resolve) => setTimeout(resolve, sent[0]! + 60_000 - now));
    }
    sent.push(Date.now());
    return fetch(input, init);
  };
}
