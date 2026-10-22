// The SecretProvider port in process memory: a map per namespace. For
// tests and single-process embedding only — the api writes and the worker
// reads from separate processes, so no deployment can run on it. The
// conformance suite (test/secret-provider-conformance.ts) pins it to the
// same contract every real adapter meets.

import { type SecretInfo, SecretNotFoundError, type SecretProvider } from "@funky/agent";

export interface MemorySecretProviderOptions {
  /** Stamps createdAt and updatedAt. Defaults to the wall clock. */
  now?: () => Date;
}

interface Stored {
  value: string;
  createdAt: string;
  updatedAt: string;
}

export function createMemorySecretProvider(options?: MemorySecretProviderOptions): SecretProvider {
  const now = options?.now ?? (() => new Date());
  const namespaces = new Map<string, Map<string, Stored>>();

  return {
    async put(ref, value) {
      let names = namespaces.get(ref.namespace);
      if (!names) {
        names = new Map();
        namespaces.set(ref.namespace, names);
      }
      const at = now().toISOString();
      const stored = { value, createdAt: names.get(ref.name)?.createdAt ?? at, updatedAt: at };
      names.set(ref.name, stored);
      return toInfo(ref.name, stored);
    },

    async delete(ref) {
      return namespaces.get(ref.namespace)?.delete(ref.name) ?? false;
    },

    async list(namespace) {
      const names = namespaces.get(namespace) ?? new Map<string, Stored>();
      return [...names]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([name, stored]) => toInfo(name, stored));
    },

    async resolve(namespace, names) {
      const stored = namespaces.get(namespace);
      const values = new Map<string, string>();
      const missing: string[] = [];
      for (const name of new Set(names)) {
        const found = stored?.get(name);
        if (found) values.set(name, found.value);
        else missing.push(name);
      }
      if (missing.length > 0) throw new SecretNotFoundError(namespace, missing);
      return values;
    },
  };
}

function toInfo(name: string, stored: Stored): SecretInfo {
  return { name, createdAt: stored.createdAt, updatedAt: stored.updatedAt };
}
