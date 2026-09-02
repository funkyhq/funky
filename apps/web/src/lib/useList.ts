// apps/web/src/lib/useList.ts
// The machine every resource list in this console runs: the first page in
// flight, a keyset walk for the rest, and a reload that cancels whatever
// that walk was doing. Generic over the row, because none of it is about
// what the rows are — the sections differ in their columns and their
// actions, not in how they load.
import { useEffect, useRef, useState } from "react";
import type { Page } from "./api";

/** What a list is showing right now. `ready` is the only state with rows;
 *  the others are what the page draws instead of a table. */
export type ListState<T> =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; items: T[]; hasMore: boolean; cursor?: string };

/**
 * One page of rows. The api's list functions already have this shape, so a
 * section passes its own straight in — and because they are module-level
 * functions they are stable, which is what lets this be an effect
 * dependency rather than something held in a ref.
 */
export type FetchPage<T> = (opts: { after?: string; signal: AbortSignal }) => Promise<Page<T>>;

/** Placeholder rows while the first page is in flight — one per row a table
 *  draws, so arriving data replaces them without the layout jumping. */
export const SKELETON = [0, 1, 2];

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Rows keyed by `id`, newest first, with `prepend`/`replace` for the ones a
 * page changes itself: this console's lists are ordered by creation, and no
 * edit it can make moves a row, so a changed row is replaced where it is
 * rather than re-fetched.
 */
export function useList<T extends { id: string }>(fetchPage: FetchPage<T>) {
  const [state, setState] = useState<ListState<T>>({ status: "loading" });
  const [more, setMore] = useState<{ busy: boolean; error?: string }>({ busy: false });
  // Bumped to re-run the effect — refresh and retry both go through
  // reload(), so a reload is one code path.
  const [reloads, setReloads] = useState(0);
  // The in-flight next-page request, if any. Held so a reload can cancel
  // it: its rows belong to the walk being replaced, not to the new one.
  const pagination = useRef<AbortController | null>(null);

  // The reset lives here rather than in the effect: the click is what makes
  // this loading again, and the effect's job is only to fetch.
  function reload() {
    setState({ status: "loading" });
    setMore({ busy: false });
    setReloads((n) => n + 1);
  }

  useEffect(() => {
    const abort = new AbortController();
    fetchPage({ signal: abort.signal }).then(
      (page) =>
        setState({
          status: "ready",
          items: page.data,
          hasMore: page.hasMore,
          cursor: page.lastId,
        }),
      (err: unknown) => {
        if (abort.signal.aborted) return;
        setState({ status: "error", message: messageOf(err) });
      },
    );
    return () => {
      abort.abort();
      // Same generation, same fate: a page still arriving would otherwise
      // append itself to — and move the cursor of — a list it is no longer
      // part of, dropping or duplicating rows on the next Load more.
      pagination.current?.abort();
    };
  }, [fetchPage, reloads]);

  // The next page, appended. `cursor` is the previous page's last id — the
  // keyset the api hands back, not an offset, so rows created meanwhile
  // never shift the walk.
  async function loadMore() {
    if (state.status !== "ready" || state.cursor === undefined || more.busy) return;
    const abort = new AbortController();
    pagination.current = abort;
    setMore({ busy: true });
    try {
      const page = await fetchPage({ after: state.cursor, signal: abort.signal });
      setState((prev) =>
        prev.status === "ready"
          ? {
              ...prev,
              items: [...prev.items, ...page.data],
              hasMore: page.hasMore,
              cursor: page.lastId,
            }
          : prev,
      );
      setMore({ busy: false });
    } catch (err) {
      // Superseded by a reload, which has already reset this — nothing to
      // report, and nothing of this walk left to report it against.
      if (err instanceof DOMException && err.name === "AbortError") return;
      // The rows already on screen are still good: only the page that
      // failed is news, so it reports beside the button, not over the list.
      setMore({ busy: false, error: messageOf(err) });
    }
  }

  /** A row just created. It is the newest, and this list is newest-first, so
   *  it goes on the front; the cursor is a keyset rather than an offset, so
   *  a row arriving at the head leaves the rest of the walk exactly where it
   *  was and there is nothing to re-fetch. */
  function prepend(item: T) {
    // Off the ready path there is no list to add it to — the load that was
    // already needed is what will show it.
    if (state.status !== "ready") {
      reload();
      return;
    }
    setState((prev) =>
      prev.status === "ready" ? { ...prev, items: [item, ...prev.items] } : prev,
    );
  }

  /** A row that changed, put back where it was — see the header. */
  function replace(item: T) {
    setState((prev) =>
      prev.status === "ready"
        ? { ...prev, items: prev.items.map((row) => (row.id === item.id ? item : row)) }
        : prev,
    );
  }

  return { state, more, reload, loadMore, prepend, replace };
}
