// apps/web/src/lib/useEntries.ts
// One session's log, loaded once and then followed: a read for what is
// already there, an EventSource for what lands next.
//
// Two mechanisms because the api built each for its half. /entries answers
// the whole log in one round trip, which is the right shape for a page
// opening on a session that already has a hundred rows behind it, and
// /stream replays from a cursor before it tails — so opening the stream at
// the read's last seq loses nothing in the gap between the two calls.
//
// Following the log is the browser's job here rather than a poll of ours:
// EventSource reconnects on its own and resumes with Last-Event-ID, which
// the route honors over `after`. Every reconnect therefore picks up exactly
// where the last delivered entry left off, with no cursor for this file to
// keep.
import { useEffect, useState } from "react";
import { type SessionEntry, entryStreamUrl, readEntries } from "./api";

/** What the log is showing. `ready` is the only state with rows; entries
 *  arrive into it afterwards, so it is not a terminal state. */
export type LogState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; entries: SessionEntry[] };

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * The log, appended to as it grows.
 *
 * `tail` is whether to follow it at all: an archived session takes no
 * further write, so there is nothing to wait for and the stream — which has
 * no server-side end — would sit open forever heartbeating at a log that
 * cannot change.
 */
export function useEntries(id: string, tail: boolean) {
  const [state, setState] = useState<LogState>({ status: "loading" });
  // Whether the connection has failed since it was opened. The only part of
  // being live that this can't work out for itself — a drop is news from
  // outside — so it is the only part that is state.
  const [dropped, setDropped] = useState(false);
  // Where the tail starts, and the fact that the read has finished: an
  // object, because `after` is legitimately absent for an empty log and
  // that must not read as "not loaded yet".
  const [start, setStart] = useState<{ after?: number }>();
  const [reloads, setReloads] = useState(0);

  /**
   * Whether the log on screen is one that keeps up.
   *
   * Attached, rather than "a byte has arrived": nothing reaches the client
   * until the api writes one, and on a quiet session that is the keep-alive
   * a whole heartbeat later — so a tail that works perfectly would report
   * itself broken for as long as the session had nothing to say.
   */
  const live = tail && start !== undefined && !dropped;

  function reload() {
    setState({ status: "loading" });
    setStart(undefined);
    setDropped(false);
    setReloads((n) => n + 1);
  }

  useEffect(() => {
    const abort = new AbortController();
    readEntries(id, { signal: abort.signal }).then(
      (entries) => {
        // The api answers in seq order and this sorts anyway: ordering is
        // what the rest of this file's reasoning rests on — the tail cursor
        // is the last row's seq — so it is established here rather than
        // assumed from the store's ORDER BY.
        const sorted = [...entries].sort((a, b) => a.seq - b.seq);
        setState({ status: "ready", entries: sorted });
        setStart({ after: sorted[sorted.length - 1]?.seq });
      },
      (err: unknown) => {
        if (abort.signal.aborted) return;
        setState({ status: "error", message: messageOf(err) });
      },
    );
    return () => abort.abort();
  }, [id, reloads]);

  useEffect(() => {
    // Nothing to follow, or nothing to follow FROM: opening the stream
    // before the read lands would replay the whole log over it.
    if (!tail || start === undefined) return;
    const source = new EventSource(entryStreamUrl(id, start.after));
    // A reconnect that got through, after `error` below marked one as
    // dropped.
    source.onopen = () => setDropped(false);
    source.onmessage = (event: MessageEvent<string>) => {
      const entry = JSON.parse(event.data) as SessionEntry;
      setState((prev) => {
        if (prev.status !== "ready") return prev;
        // A session's log is append-only and its seq gapless, so anything
        // at or behind the tail is a replay — a reconnect resuming one
        // entry early, say — and never news.
        const last = prev.entries[prev.entries.length - 1];
        if (last !== undefined && entry.seq <= last.seq) return prev;
        return { ...prev, entries: [...prev.entries, entry] };
      });
    };
    // A dropped connection is retried by EventSource itself; an http
    // failure closes it for good. Either way the log on screen is still
    // what the read returned, so this dims the live mark rather than
    // throwing the transcript away.
    source.onerror = () => setDropped(true);
    return () => source.close();
  }, [id, tail, start]);

  return { state, live, reload };
}
