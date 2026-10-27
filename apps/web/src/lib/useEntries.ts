// apps/web/src/lib/useEntries.ts
// One session's log, loaded once and then followed: a read for what is
// already there, then the same read again, from the last seq on screen,
// for what lands next.
//
// Polling rather than a held connection because funky runs deferrable
// batch work: a second's lag on a log is nothing, and a poll holds nothing
// open between answers. The cursor is the last seq the poll has taken
// in, so a poll that fails is simply asked again — nothing is lost, and
// nothing arrives twice. Up to a point: after MAX_FAILURES in a row the
// tail stops, since an api that has refused that often (a rotated token,
// an api that is down) is not going to answer the next one either, and a
// tab left open should not ask it once a second forever.
import { useEffect, useState } from "react";
import { type SessionEntry, readEntries } from "./api";

/** What the log is showing. `ready` is the only state with rows; entries
 *  arrive into it afterwards, so it is not a terminal state. */
export type LogState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; entries: SessionEntry[] };

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** How long after one poll answers the next one goes out. */
const POLL_MS = 1000;

/** How many polls in a row may fail before the tail stops asking. About
 *  ten seconds of trying: a redeploy's gap, not an outage. */
const MAX_FAILURES = 10;

/**
 * The log, appended to as it grows.
 *
 * `tail` is whether to follow it at all: an archived session takes no
 * further write, so there is nothing to wait for and a poll would ask
 * forever after a log that cannot change.
 */
export function useEntries(id: string, tail: boolean) {
  const [state, setState] = useState<LogState>({ status: "loading" });
  // How many polls in a row have failed. The only part of being live that
  // this can't work out for itself — a failure is news from outside — so it
  // is the only part that is state.
  const [failures, setFailures] = useState(0);
  // Where the tail starts, and the fact that the read has finished: an
  // object, because `after` is legitimately absent for an empty log and
  // that must not read as "not loaded yet".
  const [start, setStart] = useState<{ after?: number }>();
  const [reloads, setReloads] = useState(0);

  /**
   * Whether the log on screen is one that keeps up.
   *
   * Answered, rather than "an entry has arrived": a quiet session answers
   * every poll with nothing, and a tail that works perfectly would report
   * itself broken for as long as the session had nothing to say.
   */
  const live = tail && start !== undefined && failures === 0;

  /** Whether the tail has given up: it asks again only through `refresh`. */
  const stopped = failures >= MAX_FAILURES;

  /**
   * Read the log again, keeping the rows already on screen until the answer
   * lands: they are still true, and this is only asking what has joined
   * them.
   *
   * What ARCHIVING needs. The transition can append — a message parked
   * behind a cancelled run is drained into the log by the same transaction
   * — and it closes the tail in the same move, since an archived session
   * has nothing left to follow. The poll stops with it, so those last
   * entries could land just after the only thing watching for them went
   * away, and the page would sit on a log one short of final with no way to
   * ask again.
   *
   * And what restarts a tail that has stopped: the same read, so whatever
   * landed while nothing was asking arrives with it.
   */
  function refresh() {
    setStart(undefined);
    setFailures(0);
    setReloads((n) => n + 1);
  }

  /** The same read, from empty. What a failed load's retry does: what is on
   *  screen there is an error rather than a log, so there is nothing to
   *  hold on to while the read is in flight. */
  function reload() {
    setState({ status: "loading" });
    refresh();
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
    // Nothing to follow, or nothing to follow FROM: polling before the read
    // lands would ask for the whole log over it.
    if (!tail || start === undefined) return;
    const abort = new AbortController();
    let cursor = start.after;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let polling = false;
    let failed = 0;

    // One at a time: the next poll is scheduled when this one answers,
    // never on a fixed beat, so a slow api is never asked twice at once.
    async function poll() {
      timer = undefined;
      polling = true;
      try {
        const entries = await readEntries(id, { after: cursor, signal: abort.signal });
        const sorted = [...entries].sort((a, b) => a.seq - b.seq);
        cursor = sorted[sorted.length - 1]?.seq ?? cursor;
        failed = 0;
        setFailures(0);
        if (sorted.length > 0) {
          setState((prev) => {
            if (prev.status !== "ready") return prev;
            // A session's log is append-only and its seq gapless, so
            // anything at or behind the tail is already on screen.
            const last = prev.entries[prev.entries.length - 1];
            const fresh =
              last === undefined ? sorted : sorted.filter((entry) => entry.seq > last.seq);
            return fresh.length === 0 ? prev : { ...prev, entries: [...prev.entries, ...fresh] };
          });
        }
      } catch {
        // The log on screen is still what the reads returned, so a failure
        // dims the live mark rather than throwing the transcript away, and
        // the next poll asks again from the same cursor.
        if (!abort.signal.aborted) setFailures(++failed);
      } finally {
        polling = false;
      }
      schedule();
    }

    // A hidden tab is not polled: nobody is reading the log, so the next
    // poll waits for the tab to come back and goes out the moment it does.
    function schedule() {
      if (abort.signal.aborted || document.hidden || failed >= MAX_FAILURES) return;
      timer = setTimeout(poll, POLL_MS);
    }

    function onVisibility() {
      if (document.hidden) {
        clearTimeout(timer);
        timer = undefined;
      } else if (timer === undefined && !polling && failed < MAX_FAILURES) {
        void poll();
      }
    }

    schedule();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      abort.abort();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [id, tail, start]);

  return { state, live, stopped, reload, refresh };
}
