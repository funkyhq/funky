import { describe, expect, it } from "vitest";
import { Credentials, SetupCommands } from "../src/environment";

const STRIPE = {
  type: "injected",
  env: "STRIPE_API_KEY",
  secret: "stripe-live",
  domains: ["api.stripe.com"],
  header: "Authorization",
  value: "Bearer {secret}",
};
const GITHUB = {
  type: "injected",
  env: "GH_TOKEN",
  secret: "github",
  domains: ["api.github.com"],
  header: "Authorization",
  value: "Bearer {secret}",
};

/** The issues a list draws, each as "path: message". */
const problems = (credentials: unknown[]) => {
  const result = Credentials.safeParse(credentials);
  return result.success
    ? []
    : result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
};

describe("credentials", () => {
  it("accepts injected keys, by name only — no value rides in the config", () => {
    expect(problems([STRIPE, GITHUB])).toEqual([]);
    expect(problems([])).toEqual([]);
  });

  it("requires the type, and injected is the only one", () => {
    const { type: _, ...untyped } = STRIPE;
    expect(problems([untyped])).toEqual(['0.type: Invalid input: expected "injected"']);
    expect(problems([{ ...STRIPE, type: "unsafe" }])).toEqual([
      '0.type: Invalid input: expected "injected"',
    ]);
  });

  it("refuses a field the type doesn't take, rather than drop it", () => {
    expect(problems([{ ...STRIPE, secretValue: "sk_live_1" }])).toEqual([
      '0: Unrecognized key: "secretValue"',
    ]);
  });

  it("takes env names a shell can set, and secret names the secret store takes", () => {
    expect(problems([{ ...STRIPE, env: "_STRIPE_KEY2" }])).toEqual([]);
    for (const env of ["2FA_CODE", "STRIPE-KEY", "STRIPE KEY", ""]) {
      expect(problems([{ ...STRIPE, env }])).toEqual([
        "0.env: letters, digits and _, not starting with a digit",
      ]);
    }
    for (const secret of ["has.dot", "a".repeat(65), ""]) {
      expect(problems([{ ...STRIPE, secret }])).toEqual([
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
    expect(problems([STRIPE, { ...GITHUB, env: "STRIPE_API_KEY" }])).toEqual([
      "1.env: STRIPE_API_KEY is already set by credentials.0",
    ]);
  });

  it("gives each header on a domain one credential, whatever the header's case", () => {
    expect(problems([STRIPE, { ...STRIPE, env: "STRIPE_KEY", header: "authorization" }])).toEqual([
      "1.domains: authorization on api.stripe.com is already set by credentials.0",
    ]);
    expect(problems([{ ...STRIPE, domains: ["api.stripe.com", "api.stripe.com"] }])).toEqual([
      "0.domains: Authorization on api.stripe.com is already set by credentials.0",
    ]);
    // One stored key under a second env name, for another domain or header.
    expect(
      problems([STRIPE, { ...STRIPE, env: "FILES_KEY", domains: ["files.stripe.com"] }]),
    ).toEqual([]);
    expect(
      problems([STRIPE, { ...STRIPE, env: "STRIPE_ACCOUNT", header: "Stripe-Account" }]),
    ).toEqual([]);
  });
});

/** The issues a setup list draws, each as "path: message". */
const setupProblems = (commands: unknown) => {
  const result = SetupCommands.safeParse(commands);
  return result.success
    ? []
    : result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
};

describe("setup commands", () => {
  it("takes shell commands, in order, and none at all", () => {
    const commands = [
      "monid keys add --key monid_funky_injected --label funky",
      "monid keys add --key monid_funky_injected --label funky",
      "mkdir -p ~/skills/monid && cat > ~/skills/monid/SKILL.md <<'EOF'\n# Monid\nEOF",
    ];
    expect(SetupCommands.parse(commands)).toEqual(commands);
    expect(setupProblems([])).toEqual([]);
  });

  it("refuses a blank command", () => {
    for (const command of ["", " ", "\n\t"]) {
      expect(setupProblems(["true", command])).toEqual(["1: must not be blank"]);
    }
  });

  it("refuses NUL, which no shell command can carry", () => {
    expect(setupProblems(["echo a\0b"])).toEqual(["0: must not contain NUL"]);
  });

  it("takes a list of strings, not one string", () => {
    expect(setupProblems("monid keys add")).toHaveLength(1);
    expect(setupProblems([["monid", "keys", "add"]])).toHaveLength(1);
  });
});
