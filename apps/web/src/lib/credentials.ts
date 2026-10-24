// apps/web/src/lib/credentials.ts
// Credentials as a form: one card of fields per credential, and the
// conversions between a config's list and the cards. Shared by the agent
// config dialogs, which write the same field and must not drift apart in
// how they read it (the arrangement lib/network.ts has).
import type { Credential } from "./api";
import { parseDomains } from "./network";

/** One credential while it is being filled, its domains as typed. */
export type CredentialFields = {
  env: string;
  secret: string;
  domains: string;
  header: string;
  value: string;
};

/** A new card, starting from the commonest shape — a bearer token in
 *  Authorization — so most credentials need only the env var, the secret
 *  and a domain. */
export const NEW_CREDENTIAL: CredentialFields = {
  env: "",
  secret: "",
  domains: "",
  header: "Authorization",
  value: "Bearer {secret}",
};

/** A config's credentials as cards, for a form that starts from one. */
export function fieldsOf(credentials: Credential[]): CredentialFields[] {
  return credentials.map((credential) => ({
    env: credential.env,
    secret: credential.secret,
    domains: credential.domains.join(", "),
    header: credential.header,
    value: credential.value,
  }));
}

/**
 * The cards as credentials — or nothing while a card has an empty field: a
 * credential missing its env var, secret, domain, header or value isn't one
 * yet, so a form waits for it rather than sending it. Everything else —
 * what a name or a domain may look like, two cards claiming one env var —
 * is the api's to judge, and its refusal names the field.
 */
export function toCredentials(cards: CredentialFields[]): Credential[] | undefined {
  const credentials: Credential[] = [];
  for (const card of cards) {
    const env = card.env.trim();
    const secret = card.secret.trim();
    const domains = parseDomains(card.domains);
    const header = card.header.trim();
    if (env === "" || secret === "" || domains.length === 0 || header === "" || card.value === "") {
      return undefined;
    }
    credentials.push({ type: "injected", env, secret, domains, header, value: card.value });
  }
  return credentials;
}

/** Whether two lists say the same thing, field for field and in order.
 *  What an edit compares against to know whether there is anything to save. */
export function sameCredentials(a: Credential[], b: Credential[]): boolean {
  const canonical = (credentials: Credential[]) =>
    JSON.stringify(credentials.map((c) => [c.type, c.env, c.secret, c.domains, c.header, c.value]));
  return canonical(a) === canonical(b);
}
