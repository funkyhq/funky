// apps/web/src/pages/SessionDetail.tsx
// One session, as the conversation it is: the log above, a box to add to
// it below.
//
// A page rather than a dialog, unlike the config editors. A config is a
// form — a handful of fields you change and close — where a session is a
// place you stay, reading a log that grows while you watch it, so it gets
// the pane, the back link and its own route (`#/session/<id>`).
//
// The transcript is pages/Transcript.tsx; the loading and following of the
// log is lib/useEntries.ts. What is left here is the session row itself,
// the composer, Archive — the one control on this page that changes the
// session rather than adding to it — and the one thing none of those can
// know: which of the messages this client has sent are still missing from
// the log (Sent).
import {
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  ApiError,
  type Session,
  type SessionEntry,
  type UserMessage,
  archiveSession,
  getSession,
  sendMessage,
} from "../lib/api";
import { RELATIVE_TICK_MS, absoluteTime, relativeTime } from "../lib/format";
import { useEntries } from "../lib/useEntries";
import { useNow } from "../lib/useNow";
import { ArrowLeftIcon, RefreshIcon, SendIcon } from "../components/Icons";
import { Status } from "../components/Status";
import { SESSION_STATUS } from "../lib/status";
import { Transcript } from "./Transcript";
import "./SessionDetail.css";

/** The section this page sits under — where its back link goes. */
const SECTION = "#/session";

/** How tall the composer may grow before it scrolls instead. */
const COMPOSE_MAX = 168;

/** Within this far of the bottom counts as reading the tail, so a new entry
 *  scrolls into view; further up is reading history, which must not be
 *  yanked away. */
const PINNED_PX = 64;

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** One array for every "no log yet", so a render before the read lands
 *  doesn't look like a change to the one after it. */
const EMPTY: SessionEntry[] = [];

/** What a user message's text was — how a pending bubble recognises itself
 *  arriving in the log. The composer only ever sends text, so the parts it
 *  can't have (images) are not part of the comparison. */
function sentText(message: UserMessage): string {
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

/**
 * A message this client has sent that the log doesn't hold yet.
 *
 * `queued` is not a spinner: intake either starts a run or parks the message
 * behind the one already going, and a parked one is appended to the log only
 * when that run ends. Until then this client is the only place it exists —
 * which is why it is drawn beside the composer rather than in the
 * transcript, where it would be claiming to be part of a log it isn't in.
 *
 * `sinceSeq` is the log position it was sent at: an entry BEHIND that point
 * is not this message, however alike it reads.
 */
type Sent = {
  /** Local, and never a log id: this message has no seq yet. */
  id: string;
  text: string;
  sinceSeq: number;
  /**
   * Where it has got to. A send that stopped stays HERE rather than going
   * back into the draft — two sends can be in flight at once, so one box is
   * not somewhere two failures can both be put.
   *
   * "failed" and "unconfirmed" are the two ways it can stop, and the
   * difference is whether a retry is safe (see deliver).
   */
  state: "sending" | "queued" | "failed" | "unconfirmed";
  /** Whether the api answered that it took this message. An acknowledged
   *  send HAS an entry, or will have one when the current turn ends; an
   *  unanswered one may never. Which is what decides who claims what in
   *  outstanding(). */
  acknowledged: boolean;
  /** The api's own words, when it gave any. */
  error?: string;
};

/** Whether a send is still on its way, as against stopped. */
const inFlight = (message: Sent) => message.state === "sending" || message.state === "queued";

/**
 * The sends the log hasn't caught up with — which is at once for one that
 * started a run, and only at the end of the current turn for one that
 * queued behind it.
 *
 * Matched ONE FOR ONE. Two identical messages sent before either lands
 * share a sinceSeq and read alike, so a test applied per message would let
 * the first entry to arrive settle both and hide a message still waiting.
 * Each entry is claimed by at most one send.
 *
 * Who claims first is not send order but CERTAINTY, in two passes:
 *
 *  - A send the api acknowledged has an entry coming, so it claims one
 *    before anything else does.
 *  - An unanswered one may have no entry at all, so it takes only what is
 *    left. Oldest-first alone would let an older unconfirmed row take the
 *    entry belonging to a later accepted resend of the same text — hiding a
 *    warning that still stands, and leaving the accepted send waiting on an
 *    entry that has already been spoken for.
 *  - A refused one claims nothing ever: the api did not take it, so no
 *    entry in this log is it.
 *
 * The walk is bounded by the oldest send's position rather than the whole
 * log: everything at or behind that was already there, so it cannot be any
 * of these.
 */
function outstanding(entries: SessionEntry[], sent: Sent[]): Sent[] {
  if (sent.length === 0) return sent;
  const earliest = Math.min(...sent.map((message) => message.sinceSeq));
  const arrived: Array<{ seq: number; text: string; taken: boolean }> = [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.seq <= earliest) break;
    if (entry.type === "message" && entry.message.role === "user") {
      arrived.push({ seq: entry.seq, text: sentText(entry.message), taken: false });
    }
  }
  arrived.reverse();

  const settled = new Set<string>();
  const claim = (message: Sent) => {
    const match = arrived.find(
      (entry) => !entry.taken && entry.seq > message.sinceSeq && entry.text === message.text,
    );
    if (match === undefined) return;
    match.taken = true;
    settled.add(message.id);
  };
  for (const message of sent) {
    if (message.acknowledged) claim(message);
  }
  for (const message of sent) {
    if (!message.acknowledged && message.state !== "failed") claim(message);
  }
  return sent.filter((message) => !settled.has(message.id));
}

export function SessionDetail({ id }: { id: string }) {
  const [session, setSession] = useState<Session>();
  const [failure, setFailure] = useState<string>();
  const [draft, setDraft] = useState("");
  const [sent, setSent] = useState<Sent[]>([]);
  // Bumped to re-read the session row. Its own counter, because the log has
  // one of its own (useEntries) and either read can fail without the other.
  const [reads, setReads] = useState(0);
  const [archiving, setArchiving] = useState(false);
  // The api's refusal of an archive, and whether it was the ONE refusal
  // this page can explain: 409, the session is still working. Its own
  // state, not `failure` above — that one means the session row would not
  // load, and this page has plenty to show while this is set.
  const [refused, setRefused] = useState<{ message: string; running: boolean }>();
  const now = useNow(RELATIVE_TICK_MS);

  const archived = session?.archivedAt !== undefined;
  // Follow the log only while there is something that could still write to
  // it, and only once the row that says so has arrived.
  const { state, live, reload, refresh } = useEntries(id, session !== undefined && !archived);

  const log = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  // Whether the reader is at the tail. A ref, not state: it is read when an
  // entry lands, and nothing renders differently for it.
  const pinned = useRef(true);

  // No reset before the read: `id` never changes under this component —
  // Sessions.tsx keys it by the route — so every id starts from a fresh
  // mount, and there is no previous session's row to clear.
  useEffect(() => {
    const abort = new AbortController();
    getSession(id, { signal: abort.signal }).then(setSession, (err: unknown) => {
      if (abort.signal.aborted) return;
      setFailure(messageOf(err));
    });
    return () => abort.abort();
  }, [id, reads]);

  /** Both reads again, after either of them failed — a session that could
   *  not be fetched once is not a session this page should be stuck on. */
  function reread() {
    setFailure(undefined);
    setReads((n) => n + 1);
    reload();
  }

  /**
   * Retire the session. Terminal, taken on the click — the red label is the
   * whole of the warning, as it is in the config dialogs — but unlike a
   * config's archive this one can be REFUSED: the api takes the transition
   * only while the session is idle, and answers 409 while a worker still
   * has an item open.
   *
   * Which is why there is no disabled state for it. Nothing this console
   * can read says whether a session is running — funky derives that from
   * its work items rather than storing it on the row — so a button greyed
   * out on a guess would be wrong in both directions. The api's answer is
   * the only one there is, so it is asked, and its refusal is reported.
   */
  async function archive() {
    if (archiving || archived) return;
    setRefused(undefined);
    setArchiving(true);
    try {
      setSession(await archiveSession(id));
      // The same transaction drains a message parked behind a cancelled run
      // into the log, and the row above has just closed the tail that would
      // have carried it — an archived session is one this page stops
      // following. One more read, so what is on screen is the whole of a log
      // that can no longer change.
      refresh();
    } catch (err) {
      setRefused({
        message: messageOf(err),
        running: err instanceof ApiError && err.status === 409,
      });
    } finally {
      // Unconditional: a refusal has to leave the button pressable again,
      // and a success has already taken it off the page.
      setArchiving(false);
    }
  }

  const entries = state.status === "ready" ? state.entries : EMPTY;

  // A sent message stops being this client's business the moment the log
  // holds it, so which ones are still outstanding is READ from the log
  // rather than tracked against it — there is no second copy of the truth
  // to keep in step, and an entry arriving resolves its bubble by itself.
  const pending = outstanding(entries, sent);

  // The box grows with what is in it, up to the point where it scrolls: a
  // chat message has no length a fixed height would be right for.
  //
  // Keyed on the draft rather than done in the change handler, so every way
  // the draft moves resizes it — typing, the clear on send, the text coming
  // back after a failure — and so the FIRST render sizes it too. A textarea
  // left at its rows=1 default is a couple of pixels short of its own line
  // box, which is enough to put a scrollbar on an empty composer.
  useLayoutEffect(() => {
    const el = box.current;
    if (el === null) return;
    el.style.height = "auto";
    // scrollHeight covers the content and the padding but not the border,
    // and every box here is border-box (index.css) — so the border has to be
    // added back, or the box is set two pixels short of its own text and an
    // empty composer carries a scrollbar.
    const border = el.offsetHeight - el.clientHeight;
    el.style.height = `${Math.min(el.scrollHeight + border, COMPOSE_MAX)}px`;
  }, [draft]);

  // After the paint that added a turn, not before: scrollHeight has to
  // include it. Layout effect, so the jump is never a visible frame.
  useLayoutEffect(() => {
    const pane = log.current;
    if (pane === null || !pinned.current) return;
    pane.scrollTop = pane.scrollHeight;
  }, [entries, pending]);

  /** One message on its way, from the post to whatever the api answers. */
  async function deliver(message: Sent) {
    const settle = (change: Partial<Sent>) =>
      setSent((prev) => prev.map((row) => (row.id === message.id ? { ...row, ...change } : row)));
    try {
      const result = await sendMessage(id, message.text);
      // "started" means it is already in the log, so it leaves this list on
      // the next entry rather than by anything said here. Either way the api
      // has taken it, which is what lets its entry be claimed for it.
      settle({
        state: result.kind === "queued" ? "queued" : "sending",
        acknowledged: true,
        error: undefined,
      });
    } catch (err) {
      // Whether the api REFUSED it, which is the only answer proving it was
      // not accepted: intake runs after those checks, or not at all.
      //
      // Nothing else can be resolved, and a fresh read of the log will not
      // help. Intake either appends the message or PARKS it — a message
      // arriving behind a running turn waits in its own table until that
      // turn ends — and a parked one appears in no read this console has: it
      // is absent from /entries, and there is no route that lists it. So an
      // unanswered send is genuinely unknown, and the row says so instead of
      // offering a retry that could give the agent the same instruction
      // twice. If it did land, the log settles the row itself: at once when
      // it started a turn, and at the end of the current one when it queued.
      const refused = err instanceof ApiError && err.status !== undefined && err.status < 500;
      settle({ state: refused ? "failed" : "unconfirmed", error: messageOf(err) });
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    // `archiving` gates this as firmly as `archived` does. A message sent
    // while the transition is in flight races it, and BOTH outcomes are
    // wrong: intake opens a work item, so a message that wins refuses the
    // archive the reader just asked for (409, idle only) — and one that
    // loses is refused BY the archive and then hidden with the composer
    // its bubble was drawn in, taking the text with it.
    if (text === "" || archived || archiving) return;

    // Sent at the tail as this client last saw it. Anything at or behind
    // this seq was already in the log, so it cannot be this message.
    const sinceSeq = entries.length === 0 ? -1 : entries[entries.length - 1].seq;
    const message: Sent = {
      id: crypto.randomUUID(),
      text,
      sinceSeq,
      state: "sending",
      acknowledged: false,
    };
    setDraft("");
    // Optimistic, and honest about it: the row reads "Sending…" until the
    // api answers, then either leaves on the log's arrival or says "Queued".
    //
    // The ones the log has already caught up with are dropped in the same
    // move, so `sent` only ever holds what might still be outstanding and
    // outstanding()'s walk never lengthens with the conversation.
    setSent((prev) => [...outstanding(entries, prev), message]);
    // Nothing gates a second send: two messages in flight is a state the
    // api has an answer for — the later one queues — so the composer stays
    // open rather than pretending the conversation is turn-locked.
    await deliver(message);
  }

  /** Send a refused message again. Offered only where the api refused it —
   *  an unconfirmed one has no retry, because nothing this console can read
   *  would say whether it needs one (see deliver). Held back while an
   *  archive is in flight for the same reason a first send is (see
   *  submit) — this is a send like any other, just of an older message. */
  function retry(message: Sent) {
    if (archiving || archived) return;
    setSent((prev) =>
      prev.map((row) =>
        row.id === message.id
          ? { ...row, state: "sending", acknowledged: false, error: undefined }
          : row,
      ),
    );
    void deliver(message);
  }

  /** Give up on one. A refusal the api will keep making — an archived
   *  session, a message it won't take — needs a way out that isn't a
   *  reload, and an unconfirmed send has no other way out at all. */
  function discard(message: Sent) {
    setSent((prev) => prev.filter((row) => row.id !== message.id));
  }

  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // Enter sends and Shift+Enter breaks the line, the way every chat box
    // does. An IME composing a character is mid-word, not mid-send.
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }

  return (
    <section className="chat">
      <header className="chat-head">
        <a className="btn chat-back" href={SECTION}>
          <ArrowLeftIcon />
          Sessions
        </a>
        {session === undefined ? null : (
          <>
            <Status archivedAt={session.archivedAt} meaning={SESSION_STATUS} />
            {archived ? null : (
              <>
                <span className={live ? "live live-on" : "live"}>
                  <span className="live-dot" aria-hidden="true" />
                  {live ? "Live" : "Reconnecting…"}
                </span>
                {/* At the far end, away from the back link and the two
                    marks beside it that only report: this is the one
                    control in the head that changes the session, and the
                    one with nothing on the other side of it. */}
                <button
                  className="btn btn-archive chat-archive"
                  type="button"
                  onClick={archive}
                  disabled={archiving}
                >
                  {archiving ? "Archiving…" : "Archive"}
                </button>
              </>
            )}
          </>
        )}
      </header>

      {refused === undefined ? null : (
        <p className="chat-refused" role="alert">
          {/* The api's own words first, as everywhere else in this console,
              and this page's reading of them on a line of its own — the
              messages end without punctuation, so a clause appended to one
              would run into it as a single sentence. */}
          {refused.message}
          {refused.running ? (
            <span className="chat-refused-why">
              Archive takes an idle session, and this one still has a run open — it can be taken
              once that turn ends.
            </span>
          ) : null}
        </p>
      )}

      <p className="chat-id">{id}</p>

      {session === undefined ? (
        // Nothing to say twice: a failure is reported in the log pane below,
        // which is where the retry lives.
        failure === undefined ? (
          <p className="chat-meta">Loading…</p>
        ) : null
      ) : (
        <p className="chat-meta">
          <time dateTime={session.createdAt} title={absoluteTime(session.createdAt)}>
            Started {relativeTime(session.createdAt, now)}
          </time>
          <span>
            agent <code>{session.agentConfigId}</code> v{session.agentConfigVersion}
          </span>
          <span>
            env <code>{session.envConfigId}</code>
          </span>
          {session.sandboxId === undefined ? null : (
            <span>
              sandbox <code>{session.sandboxId}</code>
            </span>
          )}
        </p>
      )}

      <div className="chat-card">
        <div
          className="chat-log"
          ref={log}
          onScroll={(event) => {
            const pane = event.currentTarget;
            pinned.current = pane.scrollHeight - pane.scrollTop - pane.clientHeight < PINNED_PX;
          }}
        >
          {failure !== undefined ? (
            <div className="chat-state">
              <p className="chat-state-title">Couldn&rsquo;t load this session</p>
              <p>{failure}</p>
              <button className="btn" type="button" onClick={reread}>
                <RefreshIcon />
                Try again
              </button>
            </div>
          ) : state.status === "error" ? (
            <div className="chat-state">
              <p className="chat-state-title">Couldn&rsquo;t load the log</p>
              <p>{state.message}</p>
              <button className="btn" type="button" onClick={reload}>
                <RefreshIcon />
                Try again
              </button>
            </div>
          ) : state.status === "loading" ? (
            <div className="chat-state">
              <p>Loading the log…</p>
            </div>
          ) : // Nothing in the log, and nothing on its way to it. A REFUSED
          // message doesn't count as on its way: leaving the pitch out for
          // one would leave an empty card saying nothing at all.
          state.entries.length === 0 && !pending.some(inFlight) ? (
            <div className="chat-state">
              <p className="chat-state-title">Nothing said yet</p>
              <p>The first message you send is the one that starts the agent working.</p>
            </div>
          ) : (
            <div className="chat-turns">
              <Transcript entries={state.entries} now={now} />
            </div>
          )}
        </div>

        {archived ? (
          <p className="chat-closed">
            This session is archived. Its log stays readable, and it takes no new message.
          </p>
        ) : (
          <form className="chat-compose" onSubmit={submit}>
            {/* What has been sent but isn't in the log yet, stacked above
                the box that sent it. Here rather than in the transcript
                because that is exactly what it is: a message on its way,
                not a line of the conversation — the agent has not been
                given a queued one at all until its current turn ends. */}
            {pending.length === 0 ? null : (
              <ul className="chat-queue">
                {pending.map((message) => (
                  <li
                    className={inFlight(message) ? "chat-queued" : "chat-queued chat-queued-bad"}
                    key={message.id}
                  >
                    <span className="chat-queued-row">
                      <span className="chat-queued-state">
                        {message.state === "queued"
                          ? "Queued"
                          : message.state === "failed"
                            ? "Failed"
                            : message.state === "unconfirmed"
                              ? "Unconfirmed"
                              : "Sending…"}
                      </span>
                      <span className="chat-queued-text" title={message.text}>
                        {message.text}
                      </span>
                      {inFlight(message) ? null : (
                        <span className="chat-queued-actions">
                          {/* Only a refusal may be sent again: see deliver. */}
                          {message.state === "failed" ? (
                            <button
                              type="button"
                              onClick={() => retry(message)}
                              disabled={archiving}
                            >
                              Retry
                            </button>
                          ) : null}
                          <button type="button" onClick={() => discard(message)}>
                            Discard
                          </button>
                        </span>
                      )}
                    </span>
                    {message.error === undefined ? null : (
                      <p className="chat-queued-error" role="alert">
                        {message.error}
                        {message.state === "unconfirmed"
                          ? " It may have been sent even so — if it was, it joins the conversation" +
                            " when the current turn ends."
                          : null}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <div className="chat-compose-row">
              <textarea
                className="compose-box"
                ref={box}
                aria-label="Message"
                rows={1}
                value={draft}
                placeholder="Send a message…"
                disabled={session === undefined || archiving}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={keyDown}
              />
              <button
                className="btn btn-primary compose-send"
                type="submit"
                disabled={draft.trim() === "" || session === undefined || archiving}
              >
                <SendIcon />
                Send
              </button>
            </div>
          </form>
        )}
      </div>
    </section>
  );
}
