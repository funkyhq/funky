// The SecretProvider port
//
// Where a namespace's keys live: values a user stores once and agent
// configs refer to by name, so a value never rides in a config, an entry,
// or a response. Funky keeps no values itself — an adapter puts them in a
// secret manager the deployment already runs, and this port is the whole
// of what Funky asks of one.
//
// Two callers, two halves: the api writes (put, delete) and lists names
// back to the user; the worker reads values (resolve) when it provisions
// a sandbox. resolve is the only method that returns a value, and nothing
// that answers a user calls it — which is what keeps the store write-only
// from the outside.
//
// Contract for implementations:
// - Addressing is by namespace-scoped name (SecretRef): the namespace is
//   part of the address, not a filter. A name stored under another
//   namespace is unknown — resolve rejects it, list omits it, delete
//   reports it absent — exactly like a name never stored, so one
//   tenant's reference can never reach another's value.
// - put creates or replaces, last write wins; a replace keeps the name's
//   createdAt. Values are opaque and stored verbatim.
// - resolve is all-or-nothing: every name asked for, or SecretNotFoundError
//   naming each missing one. A transient failure (the manager unreachable,
//   a rate limit) MUST NOT surface as SecretNotFoundError — callers end
//   runs on it.
// - list returns names and timestamps only, sorted by name.
// - Callers validate names and values; an adapter may still reject what
//   its backend cannot store, by throwing.

/**
 * resolve()'s "not stored" rejection: these names have no value in this
 * namespace — never put, deleted, or put under another namespace. Callers
 * act on it as definitive, so adapters MUST throw it only when the
 * manager confirms a name is absent, never for a transient failure.
 */
export class SecretNotFoundError extends Error {
  readonly namespace: string;
  readonly names: readonly string[];

  constructor(namespace: string, names: readonly string[]) {
    super(`secrets not found in namespace ${namespace}: ${names.join(", ")}`);
    this.name = "SecretNotFoundError";
    this.namespace = namespace;
    this.names = names;
  }
}

export interface SecretProvider {
  /** Store the value under the name, replacing any current one. */
  put(ref: SecretRef, value: string): Promise<SecretInfo>;
  /** Remove the name. Resolves false when it is not stored. */
  delete(ref: SecretRef): Promise<boolean>;
  /** The namespace's stored names, sorted, without their values. */
  list(namespace: string): Promise<SecretInfo[]>;
  /** The values for these names, keyed by name. Rejects with
   *  SecretNotFoundError naming every one not stored in the namespace. */
  resolve(namespace: string, names: readonly string[]): Promise<Map<string, string>>;
}

/** A namespace-scoped secret name. */
export interface SecretRef {
  namespace: string;
  name: string;
}

/** What a read may say about a stored secret: never its value. */
export interface SecretInfo {
  name: string;
  /** ISO 8601: the first put. */
  createdAt: string;
  /** ISO 8601: the latest put. */
  updatedAt: string;
}
