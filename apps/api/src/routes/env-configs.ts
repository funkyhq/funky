// apps/api/src/routes/env-configs.ts
// The env-config resource — sandbox recipes updated in place until archive,
// their terminal state. Thin:
// validate the request shape → Store call → wire row, where the wire
// mapping only renames the ref's qualified id to the resource's `id`.
// Namespace is part of the request: the create body carries it — the
// core request schema IS the wire shape — and the other routes take
// ?namespace= (see agent-configs.ts and common.ts NamespaceQuery).
//
// One step is not thin: packages are baked into a sandbox template
// (core/store.ts TemplateBuild). A create or update whose packages
// install anything starts a build first and stores it beside them;
// the build then runs on the provider, and a read of a row still
// "building" asks the provider where it stands and records a settled
// answer. Starting comes before the write, so a recipe the builder
// refuses (UnsupportedPackagesError) is a 400 that stores nothing.
import { Hono } from "hono";
import {
  CreateEnvConfigRequest,
  type EnvConfig,
  type Packages,
  type TemplateBuild,
  UpdateEnvConfigRequest,
} from "@funky/core";
import {
  ArchivedError,
  type Store,
  type TemplateBuilder,
  type TemplateBuildStatus,
  UnsupportedPackagesError,
} from "@funky/agent";
import { errorResponse } from "../http";
import { ListQuery, NamespaceQuery, page, validate } from "./common";

/** The slice of the harness Store this resource needs. */
export type EnvConfigStore = Pick<
  Store,
  | "createEnvConfig"
  | "getEnvConfig"
  | "updateEnvConfig"
  | "archiveEnvConfig"
  | "listEnvConfigs"
  | "settleEnvConfigTemplate"
>;

type Env = { Variables: { requestId: string } };

// The core request, with the body's namespace defaulted the same way
// the query's is (common.ts NamespaceQuery).
const CreateEnvConfigBody = CreateEnvConfigRequest.extend(NamespaceQuery.shape);

/** Store row → wire resource — see the header. */
const wire = ({ envConfigId, ...rest }: EnvConfig) => ({ id: envConfigId, ...rest });

/** Whether a recipe installs anything — a manager listed with no specs doesn't. */
const installs = (packages: Packages) => Object.values(packages).some((specs) => specs.length > 0);

/** The same install, however the request ordered its managers or spelled
 *  an empty one. Spec order stays significant. */
const samePackages = (a: Packages, b: Packages) => {
  const canonical = (p: Packages) =>
    JSON.stringify(
      Object.entries(p)
        .filter(([, specs]) => specs.length > 0)
        .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)),
    );
  return canonical(a) === canonical(b);
};

export function envConfigRoutes(store: EnvConfigStore, templates: TemplateBuilder) {
  const r = new Hono<Env>();

  /** Start the template a recipe's packages need — none when they install nothing. */
  const build = async (packages: Packages): Promise<TemplateBuild | undefined> => {
    if (!installs(packages)) return undefined;
    return { ...(await templates.start(packages)), status: "building" };
  };

  /**
   * A row as of now: a "building" template is checked with the provider,
   * and a settled answer is recorded (the store applies it only if the row
   * still names that build). A provider that can't be reached leaves the
   * stored row: it can't make a read of funky's own data fail.
   */
  const current = async (config: EnvConfig): Promise<EnvConfig> => {
    const template = config.template;
    if (template?.status !== "building") return config;
    let now: TemplateBuildStatus;
    try {
      now = await templates.status(template);
    } catch (err) {
      console.warn(`env config ${config.envConfigId}: template status unavailable:`, err);
      return config;
    }
    if (now.status === "building") return config;
    const ref = { namespace: config.namespace, envConfigId: config.envConfigId };
    const settled = await store.settleEnvConfigTemplate(ref, { ...template, ...now });
    return settled ?? config;
  };

  // create → 201 with the materialized row: defaults are resolved at
  // create (network → unrestricted, packages → {}), so the caller sees
  // the decision that was stored, not the request they sent — including
  // the template build its packages started.
  r.post("/", validate("json", CreateEnvConfigBody), async (c) => {
    const req = c.req.valid("json");
    let template: TemplateBuild | undefined;
    try {
      template = await build(req.packages ?? {});
    } catch (err) {
      if (err instanceof UnsupportedPackagesError) {
        return errorResponse(c, 400, "invalid_request_error", err.message);
      }
      throw err;
    }
    const ref = await store.createEnvConfig(req, template);
    const config = await store.getEnvConfig(ref);
    if (!config) throw new Error(`env config ${ref.envConfigId} missing after create`);
    return c.json(wire(config), 201);
  });

  // list → one page of this namespace's rows, newest first. The store
  // is asked for limit + 1: the extra row is hasMore (see page()).
  r.get("/", validate("query", ListQuery), async (c) => {
    const { namespace, limit, after } = c.req.valid("query");
    try {
      const rows = await store.listEnvConfigs({ namespace, limit: limit + 1, after });
      return c.json(page((await Promise.all(rows.map(current))).map(wire), limit));
    } catch (err) {
      // The store resolves the cursor inside the namespace; a foreign
      // one is "unknown" exactly like a made-up one. Either way the
      // client sent it, so it is a 400, not a 500.
      if (err instanceof Error && err.message.startsWith("unknown cursor")) {
        return errorResponse(c, 400, "invalid_request_error", err.message);
      }
      throw err;
    }
  });

  r.get("/:id", validate("query", NamespaceQuery), async (c) => {
    const id = c.req.param("id");
    const { namespace } = c.req.valid("query");
    const config = await store.getEnvConfig({ namespace, envConfigId: id });
    if (!config) {
      return errorResponse(c, 404, "not_found_error", `no env config ${id}`);
    }
    return c.json(wire(await current(config)));
  });

  // update → the row after the edit. Packages bring their template with
  // them: the same install keeps the row's build unless it failed (sending
  // the packages again is how a failed build is retried), and any other
  // starts a new one. The 404 and 409 are answered before a build starts,
  // so a request that can't land never costs one.
  r.post(
    "/:id",
    validate("query", NamespaceQuery),
    validate("json", UpdateEnvConfigRequest),
    async (c) => {
      const id = c.req.param("id");
      const { namespace } = c.req.valid("query");
      const ref = { namespace, envConfigId: id };
      const req = c.req.valid("json");
      try {
        let template: TemplateBuild | undefined;
        if (req.packages !== undefined) {
          const before = await store.getEnvConfig(ref);
          if (!before) {
            return errorResponse(c, 404, "not_found_error", `no env config ${id}`);
          }
          if (before.archivedAt !== undefined) throw ArchivedError.forEnvConfig(ref);
          const keep =
            before.template !== undefined &&
            before.template.status !== "failed" &&
            samePackages(before.packages, req.packages);
          template = keep ? before.template : await build(req.packages);
        }
        const config = await store.updateEnvConfig(ref, req, template);
        if (!config) {
          return errorResponse(c, 404, "not_found_error", `no env config ${id}`);
        }
        return c.json(wire(config));
      } catch (err) {
        if (err instanceof UnsupportedPackagesError) {
          return errorResponse(c, 400, "invalid_request_error", err.message);
        }
        if (err instanceof ArchivedError) {
          return errorResponse(c, 409, "conflict_error", err.message);
        }
        throw err;
      }
    },
  );

  // Archive retires the recipe without deleting it. With no unarchive,
  // repeating the transition is a 200 carrying the original archivedAt.
  r.post("/:id/archive", validate("query", NamespaceQuery), async (c) => {
    const id = c.req.param("id");
    const { namespace } = c.req.valid("query");
    const config = await store.archiveEnvConfig({ namespace, envConfigId: id });
    if (!config) {
      return errorResponse(c, 404, "not_found_error", `no env config ${id}`);
    }
    return c.json(wire(config));
  });

  return r;
}
