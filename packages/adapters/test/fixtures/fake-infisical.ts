// An in-process Infisical: just the routes the Infisical SecretProvider
// calls, answering the way a live Infisical (v0.167.0) did when probed —
// values and names trimmed on write; folders and names case-sensitive; a
// missing folder answered 404, a wrong environment slug the same; a
// folder that exists refused with a 400 and made with its parents; a
// stale token refused with a 403 TokenError. What it can't do by itself
// (a write race's 500, an approval hold) a test scripts with failNext.
// infisical-live.test.ts holds the adapter to the real thing.

export const FAKE_INFISICAL = {
  siteUrl: "https://infisical.test",
  clientId: "fake-client-id",
  clientSecret: "fake-client-secret",
  projectId: "fake-project",
  environment: "prod",
};

export interface FakeRequest {
  method: string;
  /** The URL's path, without the query. */
  path: string;
  query: URLSearchParams;
  body: unknown;
}

export interface FakeInfisical {
  fetch: typeof fetch;
  /** Every request, in order. */
  requests: FakeRequest[];
  /** A secret's value as Infisical holds it: what its dashboard shows. */
  stored(secretPath: string, key: string): string | undefined;
  /** Sets a value as an edit in the Infisical dashboard would. */
  edit(secretPath: string, key: string, value: string): void;
  /** Rejects every token issued so far, as expiry would. */
  expireTokens(): void;
  /** Answers the next `METHOD /path` request with this, in its place. */
  failNext(route: string, status: number, body: Record<string, unknown>): void;
}

interface Stored {
  value: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export function createFakeInfisical(): FakeInfisical {
  const folders = new Set(["/"]);
  const secrets = new Map<string, Map<string, Stored>>();
  const tokens = new Set<string>();
  const scripted = new Map<string, { status: number; body: Record<string, unknown> }[]>();
  const requests: FakeRequest[] = [];
  let issued = 0;
  let clock = Date.parse("2026-10-22T00:00:00.000Z");

  const reply = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  const refuse = (status: number, error: string, message: string) =>
    reply(status, { statusCode: status, error, message });
  const tick = () => new Date((clock += 1000)).toISOString();
  const trimValue = (value: string) => (value.endsWith("\n") ? `${value.trim()}\n` : value.trim());
  const shape = (key: string, s: Stored, view = true) => ({
    secretKey: key,
    secretValue: view ? s.value : "<hidden-by-infisical>",
    secretValueHidden: !view,
    type: "shared",
    version: s.version,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  });

  function handle(method: string, url: URL, body: Record<string, unknown>, auth: string) {
    const route = `${method} ${url.pathname}`;
    const failure = scripted.get(route)?.shift();
    if (failure) return reply(failure.status, failure.body);

    if (route === "POST /api/v1/auth/universal-auth/login") {
      if (
        body.clientId !== FAKE_INFISICAL.clientId ||
        body.clientSecret !== FAKE_INFISICAL.clientSecret
      ) {
        return refuse(401, "UnauthorizedError", "Invalid credentials");
      }
      const accessToken = `token-${++issued}`;
      tokens.add(accessToken);
      return reply(200, { accessToken, expiresIn: 3600, accessTokenMaxTTL: 86400 });
    }
    if (!tokens.has(auth.replace(/^Bearer /, ""))) {
      return refuse(403, "TokenError", "Your token has expired. Please re-authenticate.");
    }

    if (method === "GET" && url.pathname.startsWith("/api/v1/projects/")) {
      const id = decodeURIComponent(url.pathname.slice("/api/v1/projects/".length));
      if (id !== FAKE_INFISICAL.projectId) {
        return refuse(404, "NotFound", `Project with ID '${id}' not found`);
      }
      return reply(200, { project: { id, environments: [{ slug: FAKE_INFISICAL.environment }] } });
    }

    const where = method === "GET" ? Object.fromEntries(url.searchParams) : body;
    if (where.projectId !== FAKE_INFISICAL.projectId) {
      return refuse(404, "NotFound", `Project with ID '${String(where.projectId)}' not found`);
    }
    const envFound = where.environment === FAKE_INFISICAL.environment;

    if (route === "POST /api/v2/folders") {
      if (!envFound) return refuse(404, "NotFound", "Environment not found");
      const name = String(where.name);
      if (!/^[A-Za-z0-9_-]+$/.test(name)) return refuse(422, "ValidationFailure", "bad name");
      const parent = `/${String(where.path ?? "/")
        .split("/")
        .filter(Boolean)
        .join("/")}`;
      const path = parent === "/" ? `/${name}` : `${parent}/${name}`;
      if (folders.has(path)) {
        return refuse(400, "BadRequest", `Folder with name '${name}' already exists`);
      }
      const segments = path.split("/").filter(Boolean);
      segments.forEach((_, i) => folders.add(`/${segments.slice(0, i + 1).join("/")}`));
      return reply(200, { folder: { name, path } });
    }

    const folder = String(where.secretPath ?? "/");
    if (!envFound || !folders.has(folder)) {
      return refuse(404, "SecretPathNotFound", `Folder with path '${folder}' was not found`);
    }
    const names = secrets.get(folder) ?? new Map<string, Stored>();
    secrets.set(folder, names);

    if (route === "GET /api/v4/secrets") {
      const view = url.searchParams.get("viewSecretValue") !== "false";
      return reply(200, {
        secrets: [...names].map(([key, s]) => shape(key, s, view)),
        imports: [],
      });
    }

    if (route === "PATCH /api/v4/secrets/batch") {
      const written = (body.secrets as { secretKey: string; secretValue: string }[]).map(
        ({ secretKey, secretValue }) => {
          const key = secretKey.trim();
          const at = tick();
          const prior = names.get(key);
          const next = {
            value: trimValue(secretValue),
            version: (prior?.version ?? 0) + 1,
            createdAt: prior?.createdAt ?? at,
            updatedAt: at,
          };
          names.set(key, next);
          return shape(key, next);
        },
      );
      return reply(200, { secrets: written });
    }

    if (method === "DELETE" && url.pathname.startsWith("/api/v4/secrets/")) {
      const key = decodeURIComponent(url.pathname.slice("/api/v4/secrets/".length));
      const found = names.get(key);
      if (!found) return refuse(404, "NotFound", "Secret not found");
      names.delete(key);
      return reply(200, { secret: shape(key, found) });
    }

    return refuse(404, "Not Found", `Route ${route} not found`);
  }

  return {
    requests,
    async fetch(input, init) {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      requests.push({ method, path: url.pathname, query: url.searchParams, body });
      const auth = new Headers(init?.headers).get("authorization") ?? "";
      return handle(method, url, body, auth);
    },
    stored: (secretPath, key) => secrets.get(secretPath)?.get(key)?.value,
    edit(secretPath, key, value) {
      const at = tick();
      const names = secrets.get(secretPath) ?? new Map<string, Stored>();
      secrets.set(secretPath, names);
      names.set(key, { value, version: 1, createdAt: at, updatedAt: at });
    },
    expireTokens: () => tokens.clear(),
    failNext(route, status, body) {
      scripted.set(route, [...(scripted.get(route) ?? []), { status, body }]);
    },
  };
}
