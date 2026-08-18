// Per-path serialization for the file-mutating tools (write, edit),
// with pi's deliberate boundary. executeTools runs a batch's calls in
// parallel, so two same-path mutations in one assistant message would
// interleave — an edit's read-modify-write against a concurrent write
// silently loses one while both report success, and the model then acts
// on a world that doesn't exist. That silent, unrecoverable race is the
// only one guarded. A read (or bash command) racing a same-batch
// mutation is deliberately not queued: bash is opaque about the paths
// it touches, and a stale or missing read is a visible result the model
// corrects on the next step. Parallel calls are the model's own
// assertion that the calls are independent.
//
// Keys are lexically normalized path strings — "./a" and "a" share a
// queue; relative-vs-absolute spellings and symlinks do not (resolving
// those needs a sandbox round-trip per call, which the guard isn't
// worth; pi resolves realpath only because its filesystem is local).
// Across steps there is no race at all: the one-open-item invariant
// means a session's tools have exactly one executor at a time.

import { posix } from "node:path";

export type FileQueue = <T>(path: string, task: () => Promise<T>) => Promise<T>;

export function createFileQueue(): FileQueue {
  const tails = new Map<string, Promise<unknown>>();
  return (path, task) => {
    const key = posix.normalize(path);
    const run = (tails.get(key) ?? Promise.resolve()).then(task, task);
    tails.set(
      key,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  };
}
