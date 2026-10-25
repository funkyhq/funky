// The SandboxProvider port over E2B — every method a thin veneer on the
// SDK call it names. `connect` needs no translation at all: e2b's
// `Sandbox.connect` already has the port's contract — reattach, reviving
// a paused sandbox in place, with the TTL only extended. Three spots do
// translate:
//
// - The SDK's own `lifecycle.onTimeout` default is "kill", the port's is
//   "pause", so create always passes the action explicitly.
// - `Sandbox.create` throws a plain SandboxError when E2B refuses the
//   request itself (a 400). The same request is refused every time, so
//   the port wants SandboxProvisionError (see rethrowRefusal).
// - `commands.run` throws CommandExitError on a non-zero exit; the port
//   wants a result. The catch converts. A command-deadline TimeoutError
//   also settles as a result (see settledResult for the discrimination).
//   Every other throw counts as the sandbox being unreachable: one
//   transparent reconnect (which revives a TTL-paused sandbox) and
//   retry, then the error propagates.
//
// E2B enforces every NetworkPolicy variant: allowInternetAccess: false
// is deny-all, and an allowlist is its domains in allowOut over a
// deny-all denyOut (see toNetworkOpts). So the port's reject-when-
// unenforceable clause never triggers for the network. Packages are
// installed by building a template per package set (e2b-packages.ts);
// the clause triggers there for a manager the recipe has no installer
// for, and for a build whose install command fails. The common case
// costs nothing extra: the create goes straight to the package
// template, and only its 404 — the template has no ready build yet —
// takes the build path.
//
// Credentials become network rules: on requests to a credential's
// domains, E2B's egress proxy, outside the sandbox, sets the credential's
// header with the key in its value (see toRules). The sandbox gets a
// placeholder in the credential's env and what it needs to trust the
// proxy's TLS (see credentialEnvs), never the key. E2B refuses what it
// cannot apply (more than 10 domains, more than 20 headers on one, a
// line break in a value) with a 400, so the port's reject clause for
// credentials lands on rethrowRefusal too.

import {
  ALL_TRAFFIC,
  CommandExitError,
  Sandbox as E2bSandbox,
  SandboxError,
  SandboxNotFoundError as E2bSandboxNotFoundError,
  TimeoutError,
} from "e2b";
import type {
  SandboxInfo as E2bSandboxInfo,
  SandboxNetworkOpts,
  SandboxNetworkRule,
  SandboxOpts,
} from "e2b";
import type { NetworkPolicy } from "@funky/core";
import { SandboxNotFoundError, SandboxProvisionError } from "@funky/agent";
import type {
  CommandResult,
  CreateSandboxOptions,
  ResolvedCredential,
  RunOptions,
  Sandbox,
  SandboxInfo,
  SandboxProvider,
} from "@funky/agent";
import {
  assertInstallable,
  canonicalPackages,
  e2bTemplateBuilds,
  ensureTemplate,
  installCommands,
  NPM_GLOBAL_ROOT,
  templateName,
} from "./e2b-packages";

export interface E2bProviderOptions {
  /** Defaults to the E2B_API_KEY environment variable. */
  apiKey?: string;
}

export function createE2bProvider(options?: E2bProviderOptions): SandboxProvider {
  const connection = { apiKey: options?.apiKey };
  const builds = e2bTemplateBuilds(connection);

  return {
    async create(opts?: CreateSandboxOptions): Promise<Sandbox> {
      const canonical = canonicalPackages(opts?.packages ?? {});
      assertInstallable(canonical);
      const credentials = opts?.credentials ?? [];
      // Sandbox-level envs, set here because a template's envs never
      // reach runtime commands; they survive connect and pause/resume.
      const envs = {
        ...credentialEnvs(credentials),
        // Global npm installs resolve through NODE_PATH.
        ...(canonical.some(([manager]) => manager === "npm") ? { NODE_PATH: NPM_GLOBAL_ROOT } : {}),
      };
      const sandboxOpts: SandboxOpts = {
        ...connection,
        timeoutMs: opts?.timeoutMs,
        lifecycle: { onTimeout: opts?.lifecycle ?? "pause" },
        metadata: opts?.metadata,
        ...toNetworkOpts(opts?.network, toRules(credentials)),
        ...(Object.keys(envs).length > 0 ? { envs } : {}),
      };
      const keys = credentials.map(({ key }) => key);
      const refused = (error: unknown) => rethrowRefusal(error, keys);
      if (canonical.length === 0) {
        return wrap(await E2bSandbox.create(sandboxOpts).catch(refused), connection);
      }

      const template = templateName(canonical);
      try {
        return wrap(await E2bSandbox.create(template, sandboxOpts).catch(refused), connection);
      } catch (error) {
        if (!isUnbuilt(error)) throw error;
      }
      await ensureTemplate(builds, template, installCommands(canonical));
      return wrap(await E2bSandbox.create(template, sandboxOpts).catch(refused), connection);
    },

    async connect(sandboxId: string): Promise<Sandbox> {
      try {
        return wrap(await E2bSandbox.connect(sandboxId, connection), connection);
      } catch (error) {
        // e2b's own SandboxNotFoundError is the provider confirming the
        // sandbox is gone — the port's typed rejection, not a transient.
        if (error instanceof E2bSandboxNotFoundError) {
          throw new SandboxNotFoundError(error.message);
        }
        throw error;
      }
    },

    async list(filter?: { metadata?: Record<string, string> }): Promise<SandboxInfo[]> {
      const paginator = E2bSandbox.list({
        ...connection,
        query: filter?.metadata ? { metadata: filter.metadata } : undefined,
      });
      const infos: SandboxInfo[] = [];
      while (paginator.hasNext) {
        for (const info of await paginator.nextItems()) infos.push(toInfo(info));
      }
      return infos;
    },
  };
}

function wrap(initial: E2bSandbox, connection: { apiKey?: string }): Sandbox {
  let sandbox = initial;
  const sandboxId = initial.sandboxId;

  return {
    sandboxId,

    async getInfo(): Promise<SandboxInfo> {
      return toInfo(await E2bSandbox.getInfo(sandboxId, connection));
    },

    async run(command: string, opts?: RunOptions): Promise<CommandResult> {
      try {
        return toResult(await exec(sandbox, command, opts));
      } catch (error) {
        const settled = settledResult(error);
        if (settled) return settled;
        sandbox = await E2bSandbox.connect(sandboxId, connection);
        try {
          return toResult(await exec(sandbox, command, opts));
        } catch (retryError) {
          const retried = settledResult(retryError);
          if (retried) return retried;
          throw retryError;
        }
      }
    },

    async readFile(path: string): Promise<Uint8Array> {
      return sandbox.files.read(path, { format: "bytes" });
    },

    async writeFile(path: string, data: string | Uint8Array): Promise<void> {
      // e2b's write takes string | ArrayBuffer | Blob | ReadableStream —
      // no Uint8Array — so bytes are copied into a fresh ArrayBuffer.
      await sandbox.files.write(path, typeof data === "string" ? data : toArrayBuffer(data));
    },

    async pause(): Promise<void> {
      await sandbox.pause();
    },

    async kill(): Promise<void> {
      await sandbox.kill();
    },
  };
}

function exec(sandbox: E2bSandbox, command: string, opts?: RunOptions) {
  return sandbox.commands.run(command, {
    cwd: opts?.cwd,
    timeoutMs: opts?.timeoutMs,
    onStdout: opts?.onStdout,
    onStderr: opts?.onStderr,
  });
}

function settledResult(error: unknown): CommandResult | undefined {
  if (error instanceof CommandExitError) {
    return { stdout: error.stdout, stderr: error.stderr, exitCode: error.exitCode };
  }
  // The SDK raises one TimeoutError class for four causes, told apart
  // only by message: the command exceeding its own `timeoutMs`
  // ("exceeding 'timeoutMs'"), a request exceeding `requestTimeoutMs`,
  // the sandbox hitting its TTL, and the sandbox dying mid-request.
  // Only the first is the command's own outcome (exit 124, the
  // timeout(1) convention — rerunning a command that ran too long would
  // double the damage). The other three mean the sandbox is unreachable
  // and must fall through to the reconnect, which is what revives a
  // TTL-paused sandbox. The live suite's timeout test fails loudly if
  // an SDK rewording ever breaks the match.
  if (error instanceof TimeoutError && error.message.includes("exceeding 'timeoutMs'")) {
    return { stdout: "", stderr: error.message, exitCode: 124 };
  }
  return undefined;
}

function toResult(result: { stdout: string; stderr: string; exitCode: number }): CommandResult {
  return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
}

function toInfo(info: E2bSandboxInfo): SandboxInfo {
  return { sandboxId: info.sandboxId, state: info.state, metadata: info.metadata };
}

/** A create's 404 on a package template: never built ("template … not
 *  found"), or no ready build yet ("tag 'default' does not exist" — a
 *  build is running, or the last one failed). The SDK types it only as
 *  a SandboxError with the status leading the message. */
function isUnbuilt(error: unknown): boolean {
  return error instanceof SandboxError && error.message.startsWith("404:");
}

/** A create's catch. E2B refusing the request itself — its 400: a
 *  timeout over the plan's cap, say — refuses the same request every
 *  time, so it is the port's SandboxProvisionError, and the driver ends
 *  the run with E2B's reason. Rethrown untyped it would be retried until
 *  the bind deadline, refused the same way each time, and the batch
 *  then interrupted. Only Sandbox.create's 400 means this (a template
 *  build's 400 is a collision that waiting serves, e2b-packages.ts),
 *  and, as with isUnbuilt, the SDK types it only by the status leading
 *  the message. Anything else is rethrown as is.
 *
 *  The reason is written into the session, so the request's keys are
 *  scrubbed from it. E2B's reasons name headers and domains, not values,
 *  but nothing here should rest on that. */
function rethrowRefusal(error: unknown, keys: readonly string[]): never {
  if (error instanceof SandboxError && error.message.startsWith("400:")) {
    const reason = keys.reduce(
      (message, key) => (key === "" ? message : message.replaceAll(key, "[redacted]")),
      error.message,
    );
    throw new SandboxProvisionError(`E2B refused the sandbox: ${reason}`);
  }
  throw error;
}

/** What a credential's env holds in the sandbox: a stand-in, never the
 *  key, which the proxy puts in the header instead. */
export const CREDENTIAL_PLACEHOLDER = "funky-injected";

// E2B's egress proxy terminates TLS for every host with a rule, under its
// own CA, which is in the system store. curl, git and Python's urllib
// trust it through that, and so does Node while E2B's own
// NODE_OPTIONS=--use-openssl-ca stands. These cover the rest: Node when a
// tool sets NODE_OPTIONS itself, and Python's requests and httpx (which
// the Anthropic and OpenAI SDKs use), which ship their own CA lists.
const SYSTEM_CAS = "/etc/ssl/certs/ca-certificates.crt";
const PROXY_TRUST_ENVS = {
  NODE_EXTRA_CA_CERTS: "/usr/local/share/ca-certificates/e2b-ca.crt",
  REQUESTS_CA_BUNDLE: SYSTEM_CAS,
  SSL_CERT_FILE: SYSTEM_CAS,
};

/** The sandbox's envs for its credentials: the placeholders, and the
 *  proxy's trust (none without credentials: no rule, no proxy). A
 *  credential env these also set loses to them; its placeholder carries
 *  nothing anyway. */
function credentialEnvs(credentials: readonly ResolvedCredential[]): Record<string, string> {
  if (credentials.length === 0) return {};
  return {
    ...Object.fromEntries(
      credentials.map(({ credential }) => [credential.env, CREDENTIAL_PLACEHOLDER]),
    ),
    ...PROXY_TRUST_ENVS,
  };
}

/** The credentials as E2B rules: one per domain they name, setting each
 *  header to its value with the key in place of {secret}. E2B applies a
 *  single rule to a request, the closest (a host's own over a wildcard
 *  above it, a deeper wildcard over a shallower one), so each domain's
 *  rule carries every credential that reaches it, and of two setting
 *  one header, the closer naming of the domain wins. */
function toRules(credentials: readonly ResolvedCredential[]): Record<string, SandboxNetworkRule[]> {
  const rules: Record<string, SandboxNetworkRule[]> = {};
  for (const domain of new Set(credentials.flatMap(({ credential }) => credential.domains))) {
    const reaches = (own: string) =>
      own === domain || (own.startsWith("*.") && domain.endsWith(own.slice(1)));
    const reaching = credentials
      .flatMap((resolved) =>
        resolved.credential.domains.filter(reaches).map((own) => ({ ...resolved, own })),
      )
      // Farthest first, so the closest sets a shared header last: the
      // domain itself after every wildcard, deeper wildcards later.
      .sort(
        (a, b) =>
          Number(a.own === domain) - Number(b.own === domain) || a.own.length - b.own.length,
      );
    // Keyed case-insensitively, as header names are.
    const headers = new Map<string, [name: string, value: string]>();
    for (const { credential, key } of reaching) {
      // A function, so a `$&` or `$'` in the key stays literal.
      const value = credential.value.replaceAll("{secret}", () => key);
      headers.set(credential.header.toLowerCase(), [credential.header, value]);
    }
    rules[domain] = [{ transform: { headers: Object.fromEntries(headers.values()) } }];
  }
  return rules;
}

function toNetworkOpts(
  policy: NetworkPolicy | undefined,
  rules: Record<string, SandboxNetworkRule[]>,
): Partial<SandboxOpts> {
  // E2B's egress is open unless denied, and allowOut only carves
  // exceptions out of denyOut, so the allowlist is its domains over a
  // deny-all. allowOut alone would fence nothing; E2B refuses domains
  // without the deny-all (a 400) rather than run them open. Domains
  // match on HTTP Host and TLS SNI; anything else stays denied. Rules
  // open nothing: a rule's domain the policy blocks stays blocked.
  const network: SandboxNetworkOpts = {
    ...(policy?.type === "allowlist" ? { allowOut: policy.domains, denyOut: [ALL_TRAFFIC] } : {}),
    ...(Object.keys(rules).length > 0 ? { rules } : {}),
  };
  return {
    ...(policy?.type === "none" ? { allowInternetAccess: false } : {}),
    ...(Object.keys(network).length > 0 ? { network } : {}),
  };
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
