import { describe, expect, it } from "vitest";
import { Credentials } from "../src/environment";

const STRIPE = {
  type: "injected",
  env: "STRIPE_API_KEY",
  secret: "stripe-live",
  domains: ["api.stripe.com"],
  header: "Authorization",
  value: "Bearer {secret}",
};
const PG = { type: "unsafe", env: "PGPASSWORD", secret: "pg-password" };

/** The issues a list draws, each as "path: message". */
const problems = (credentials: unknown[]) => {
  const result = Credentials.safeParse(credentials);
  return result.success
    ? []
    : result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
};

describe("credentials", () => {
  it("accepts both types, by name only — no value rides in the config", () => {
    expect(problems([STRIPE, PG])).toEqual([]);
    expect(problems([])).toEqual([]);
  });

  it("requires the type: a key is never exposed by omission", () => {
    const { type: _, ...untyped } = PG;
    expect(problems([untyped])).toEqual([
      "0.type: Invalid discriminator value. Expected 'injected' | 'unsafe'",
    ]);
    expect(problems([{ ...PG, type: "exposed" }])).toHaveLength(1);
  });

  it("refuses a field its type doesn't take, rather than drop it", () => {
    expect(problems([{ ...PG, domains: ["db.example.com"] }])).toEqual([
      '0: Unrecognized key: "domains"',
    ]);
    expect(problems([{ ...STRIPE, secretValue: "sk_live_1" }])).toEqual([
      '0: Unrecognized key: "secretValue"',
    ]);
  });

  it("takes env names a shell can set, and secret names the secret store takes", () => {
    expect(problems([{ ...PG, env: "_PG_PASSWORD2" }])).toEqual([]);
    for (const env of ["2FA_CODE", "PG-PASSWORD", "PG PASSWORD", ""]) {
      expect(problems([{ ...PG, env }])).toEqual([
        "0.env: letters, digits and _, not starting with a digit",
      ]);
    }
    for (const secret of ["has.dot", "a".repeat(65), ""]) {
      expect(problems([{ ...PG, secret }])).toEqual([
        "0.secret: 1-64 characters: letters, digits, _ and -",
      ]);
    }
  });

  it("takes lowercase hosts and wildcard subdomains as domains, at least one", () => {
    expect(problems([{ ...STRIPE, domains: ["api.stripe.com", "*.stripe.com"] }])).toEqual([]);
    expect(problems([{ ...STRIPE, domains: [] }])).toHaveLength(1);
    for (const domain of [
      "https://api.stripe.com",
      "api.stripe.com:443",
      "api.stripe.com/v1",
      "API.stripe.com",
      "stripe",
      "*",
      "api..stripe.com",
      "-api.stripe.com",
    ]) {
      expect(problems([{ ...STRIPE, domains: [domain] }])).toEqual([
        "0.domains.0: a lowercase host, such as api.example.com or *.example.com",
      ]);
    }
  });

  it("takes an HTTP header name, and a value with {secret} and no line breaks", () => {
    expect(problems([{ ...STRIPE, header: "x-api-key", value: "{secret}" }])).toEqual([]);
    expect(problems([{ ...STRIPE, header: "Author ization" }])).toEqual([
      "0.header: an HTTP header name",
    ]);
    expect(problems([{ ...STRIPE, value: "Bearer sk_live_1" }])).toEqual([
      "0.value: must contain {secret}",
    ]);
    expect(problems([{ ...STRIPE, value: "Bearer {secret}\r\nX-Injected: 1" }])).toEqual([
      "0.value: printable ASCII, with no line breaks",
    ]);
  });

  it("gives each env var one credential", () => {
    expect(problems([STRIPE, { ...PG, env: "STRIPE_API_KEY" }])).toEqual([
      "1.env: STRIPE_API_KEY is already set by credentials.0",
    ]);
    // One stored key under two names is fine.
    expect(problems([PG, { ...PG, env: "PGPASS" }])).toEqual([]);
  });

  it("gives each header on a domain one credential, whatever the header's case", () => {
    expect(problems([STRIPE, { ...STRIPE, env: "STRIPE_KEY", header: "authorization" }])).toEqual([
      "1.domains: authorization on api.stripe.com is already set by credentials.0",
    ]);
    expect(problems([{ ...STRIPE, domains: ["api.stripe.com", "api.stripe.com"] }])).toEqual([
      "0.domains: Authorization on api.stripe.com is already set by credentials.0",
    ]);
    expect(
      problems([STRIPE, { ...STRIPE, env: "FILES_KEY", domains: ["files.stripe.com"] }]),
    ).toEqual([]);
    expect(
      problems([STRIPE, { ...STRIPE, env: "STRIPE_ACCOUNT", header: "Stripe-Account" }]),
    ).toEqual([]);
  });
});
