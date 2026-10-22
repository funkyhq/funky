// The SecretProvider port over Infisical (infisical.com), Cloud or
// self-hosted, through its REST API as a machine identity signed in with
// Universal Auth. One environment of one project holds every namespace,
// a folder each: a secret lives at <path>/<namespace>/<name>. Folder
// names take exactly what a namespace may be (letters, digits, _ and -),
// so a namespace is its folder's name unencoded, and a read stays in
// that one folder: never recursing into subfolders, never following an
// import.
//
// Values are stored as given, so Infisical's dashboard shows them and an
// edit made there is what resolve returns. Infisical trims a value and
// reads `${…}` in one as a reference to another secret: what the port's
// value rules keep out (secretValueProblem). put refuses a value that
// breaks them rather than store it altered, and no read expands a
// reference regardless.
//
// Three spots translate:
//
// - put is one upsert. A namespace's folder appears on its first put:
//   the upsert's 404 creates the folder and the write runs again. Of two
//   puts creating one name, Infisical fails the loser with a 500; a retry
//   finds the name and replaces it.
// - A 404 on a namespace's folder means the namespace holds nothing. A
//   wrong environment slug draws the same 404, so the first one is
//   believed only once the project shows it has the environment: a
//   misconfigured worker throws rather than end runs on
//   SecretNotFoundError.
// - The identity signs in on first use, and again when Infisical rejects
//   its access token (expired: a 403 TokenError, not a 401).
//
// The identity needs, under `path`: read (values included), create, edit
// and delete on secrets, and create on folders. A change policy on the
// path stops writes — Infisical holds them for approval, and put and
// delete throw. Infisical keeps past values for point-in-time recovery,
// a deleted secret's included.

import {
  type SecretInfo,
  SecretNotFoundError,
  type SecretProvider,
  secretValueProblem,
} from "@funky/agent";

export interface InfisicalSecretProviderOptions {
  /** The instance. Defaults to Infisical Cloud's US region. */
  siteUrl?: string;
  /** The machine identity's Universal Auth credentials. */
  clientId: string;
  clientSecret: string;
  /** The project's id (not its slug). */
  projectId: string;
  /** The environment's slug, such as "prod". */
  environment: string;
  /** The folder the namespaces' folders go in. Defaults to the root. */
  path?: string;
  /** Defaults to the global fetch. */
  fetch?: typeof fetch;
}

/** Infisical's folder names, and so the namespaces it can hold. */
const FOLDER_NAME = /^[A-Za-z0-9_-]+$/;

/** What a secrets read or write answers per secret, as far as used here. */
interface StoredSecret {
  secretKey: string;
  secretValue: string;
  secretValueHidden?: boolean;
  createdAt: string;
  updatedAt: string;
}

interface Answer {
  method: string;
  path: string;
  status: number;
  body: unknown;
  text: string;
}

export function createInfisicalSecretProvider(
  options: InfisicalSecretProviderOptions,
): SecretProvider {
  const site = (options.siteUrl ?? "https://app.infisical.com").replace(/\/+$/, "");
  const root = `/${(options.path ?? "/").split("/").filter(Boolean).join("/")}`;
  const { projectId, environment } = options;
  const fetchFn = options.fetch ?? fetch;
  let token: Promise<string> | undefined;
  let configChecked: Promise<void> | undefined;

  async function send(
    method: string,
    path: string,
    body: unknown,
    bearer?: string,
  ): Promise<Answer> {
    const response = await fetchFn(`${site}${path}`, {
      method,
      headers: {
        ...(bearer === undefined ? {} : { authorization: `Bearer ${bearer}` }),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    return { method, path, status: response.status, body: parsed, text };
  }

  function accessToken(): Promise<string> {
    token ??= send("POST", "/api/v1/auth/universal-auth/login", {
      clientId: options.clientId,
      clientSecret: options.clientSecret,
    })
      .then((answer) => String(ok(answer).accessToken))
      .catch((error: unknown) => {
        token = undefined;
        throw error;
      });
    return token;
  }

  /** One request as the identity, signing in again once if Infisical
   *  rejects the token. */
  async function call(method: string, path: string, body?: unknown): Promise<Answer> {
    const current = accessToken();
    const answer = await send(method, path, body, await current);
    if (!rejectsToken(answer)) return answer;
    if (token === current) token = undefined;
    return send(method, path, body, await accessToken());
  }

  function folder(namespace: string): string {
    if (!FOLDER_NAME.test(namespace)) {
      throw new Error(
        `namespace ${JSON.stringify(namespace)} can't name an Infisical folder: letters, digits, _ and - only`,
      );
    }
    return root === "/" ? `/${namespace}` : `${root}/${namespace}`;
  }

  /** The namespace's secrets, or none when it has no folder. */
  async function read(namespace: string, viewSecretValue: boolean): Promise<StoredSecret[]> {
    const query = new URLSearchParams({
      projectId,
      environment,
      secretPath: folder(namespace),
      viewSecretValue: String(viewSecretValue),
      expandSecretReferences: "false",
      includeImports: "false",
      recursive: "false",
    });
    const answer = await call("GET", `/api/v4/secrets?${query}`);
    if (answer.status === 404) {
      await checkConfig();
      return [];
    }
    return ok(answer).secrets as StoredSecret[];
  }

  function checkConfig(): Promise<void> {
    configChecked ??= call("GET", `/api/v1/projects/${encodeURIComponent(projectId)}`)
      .then((answer) => {
        const project = ok(answer).project as { environments: { slug: string }[] };
        if (!project.environments.some((env) => env.slug === environment)) {
          throw new Error(`Infisical project ${projectId} has no environment "${environment}"`);
        }
      })
      .catch((error: unknown) => {
        configChecked = undefined;
        throw error;
      });
    return configChecked;
  }

  async function upsert(namespace: string, name: string, value: string): Promise<Answer> {
    const write = () =>
      call("PATCH", "/api/v4/secrets/batch", {
        projectId,
        environment,
        secretPath: folder(namespace),
        mode: "upsert",
        secrets: [{ secretKey: name, secretValue: value }],
      });

    let answer = await write();
    if (answer.status === 404) {
      // The namespace's first put. A 400 here is a concurrent put having
      // made the folder first, so the second write is the judge; only if
      // it still finds no folder is the refusal below the cause.
      const created = await call("POST", "/api/v2/folders", {
        projectId,
        environment,
        name: namespace,
        path: root,
      });
      answer = await write();
      if (answer.status === 404) ok(created);
    }
    // Perhaps the loser of a race to create the name: it exists now.
    if (answer.status >= 500) answer = await write();
    return answer;
  }

  return {
    async put(ref, value) {
      if (ref.name === "" || ref.name.trim() !== ref.name) {
        throw new Error(
          `secret name ${JSON.stringify(ref.name)} can't be stored in Infisical, which trims names`,
        );
      }
      const problem = secretValueProblem(value);
      if (problem) throw new Error(`can't store the value of ${ref.name}: it ${problem}`);
      const answer = await upsert(ref.namespace, ref.name, value);
      const secret = (done(answer, "secrets") as StoredSecret[])[0];
      if (!secret) throw new Error(`Infisical answered the put of ${ref.name} with no secret`);
      return toInfo(ref.name, secret);
    },

    async delete(ref) {
      const answer = await call("DELETE", `/api/v4/secrets/${encodeURIComponent(ref.name)}`, {
        projectId,
        environment,
        secretPath: folder(ref.namespace),
        type: "shared",
      });
      // No such name, or no folder for the namespace at all.
      if (answer.status === 404) {
        await checkConfig();
        return false;
      }
      done(answer, "secret");
      return true;
    },

    async list(namespace) {
      return (await read(namespace, false))
        .map((secret) => toInfo(secret.secretKey, secret))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    },

    async resolve(namespace, names) {
      const wanted = [...new Set(names)];
      if (wanted.length === 0) return new Map();
      const stored = new Map((await read(namespace, true)).map((s) => [s.secretKey, s]));
      const values = new Map<string, string>();
      const missing: string[] = [];
      for (const name of wanted) {
        const secret = stored.get(name);
        if (secret) values.set(name, valueOf(namespace, secret));
        else missing.push(name);
      }
      if (missing.length > 0) throw new SecretNotFoundError(namespace, missing);
      return values;
    },
  };
}

/** The answer's body when it succeeded; otherwise a throw naming what
 *  Infisical said. */
function ok(answer: Answer): Record<string, unknown> {
  const { body } = answer;
  if (answer.status >= 200 && answer.status < 300 && isRecord(body)) return body;
  const said = isRecord(body) && "message" in body ? body.message : answer.text.slice(0, 200);
  throw new Error(
    `Infisical answered ${answer.status} to ${answer.method} ${answer.path.split("?")[0]}: ${
      typeof said === "string" ? said : JSON.stringify(said)
    }`,
  );
}

/** A write's result. Under a change policy Infisical answers 200 with an
 *  approval request in its place, the change not made. */
function done(answer: Answer, key: "secret" | "secrets"): unknown {
  const body = ok(answer);
  if (!(key in body)) {
    throw new Error(
      `Infisical held ${answer.method} ${answer.path} for approval instead of making the change: Funky's folder needs no change policy`,
    );
  }
  return body[key];
}

/** Infisical rejects a stale token with a 403 TokenError (expired or
 *  malformed), or a 401. */
function rejectsToken(answer: Answer): boolean {
  return (
    answer.status === 401 ||
    (answer.status === 403 && isRecord(answer.body) && answer.body.error === "TokenError")
  );
}

function valueOf(namespace: string, secret: StoredSecret): string {
  if (secret.secretValueHidden) {
    throw new Error(
      `Infisical hid the value of ${secret.secretKey} in namespace ${namespace}: the identity can't read secret values`,
    );
  }
  return secret.secretValue;
}

function toInfo(name: string, secret: StoredSecret): SecretInfo {
  return {
    name,
    createdAt: new Date(secret.createdAt).toISOString(),
    updatedAt: new Date(secret.updatedAt).toISOString(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
