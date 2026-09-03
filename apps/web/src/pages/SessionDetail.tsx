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
// the composer, and the one thing neither of those can know: which of the
// messages this client has sent are still missing from the log (Sent).
//
// Archive is the page's one action on the session rather than in it, and
// the only one that ends it: the log stays readable, every client write
// closes, and there is no route back. It is asked for behind a dialog
// because of that — the config editors archive on the click, but they do it
// from inside a dialog you opened to edit, where this would be a single
// press on a page you land on by clicking a row.
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
import { Modal } from "../components/Modal";
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
  // The archive: whether it is being asked for, whether it is in flight,
  // and how it was refused. Its own failure rather than the page's —
  // `failure` above is the session READ, and a refusal has to be readable
  // beside the button that caused it, which is inside the dialog.
  const [confirming, setConfirming] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [archiveError, setArchiveError] = useState<string>();
  const now = useNow(RELATIVE_TICK_MS);

  const archived = session?.archivedAt !== undefined;
  // Follow the log only while there is something that could still write to
  // it, and only once the row that says so has arrived.
  const { state, live, reload } = useEntries(id, session !== undefined && !archived);

  const log = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  // Where focus lands when the dialog closes on a successful archive: the
  // button that opened it is gone by then — an archived session has no
  // archive to offer — and the back link is what stays put.
  const back = useRef<HTMLAnchorElement>(null);
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
   * Archive, on the dialog's confirming click. Terminal and idempotent, and
   * the one write on this page the api can refuse for a reason worth
   * explaining: the store serializes this transition with intake and
   * answers 409 while the session still has an open work item, so a refusal
   * here is a request made too early rather than a broken one.
   *
   * Nothing else is reset on success. The row it returns carries the mark,
   * and everything that follows from it — the pill, the closed composer,
   * the stream shutting itself off — is read from that one value.
   */
  async function archive() {
    if (archiving) return;
    setArchiveError(undefined);
    setArchiving(true);
    try {
      // No abort signal, for the reason the create dialogs use none: a
      // write in flight may well have landed, so the dialog stops being
      // dismissible rather than walking away from an answer it would then
      // have to guess at.
      const retired = await archiveSession(id);
      // Re-read the log, because archiving can APPEND to it: the store
      // flushes an input parked behind a cancelled run in the same
      // transaction, so a message queued before the archive lands in
      // /entries as part of it. The stream is a poll loop, and the row
      // below stops the tail at once — anything the archive wrote would
      // otherwise be missed until a full page reload, since an archived
      // session has nothing left to refresh with.
      reload();
      setSession(retired);
      setConfirming(false);
    } catch (err) {
      // The one refusal this route makes, said in the console's words
      // rather than the api's. Everywhere else the api's message is the
      // more informative of the two; this one is "session <ns>/<id> is not
      // idle", which spends four lines of a footer restating the id at the
      // top of this dialog and never says what to do about it.
      const running = err instanceof ApiError && err.status === 409;
      setArchiveError(
        running
          ? "It still has a turn in flight — archiving works once the agent has finished."
          : messageOf(err),
      );
    } finally {
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
    if (text === "" || archived) return;

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
   *  would say whether it needs one (see deliver). */
  function retry(message: Sent) {
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
        <a className="btn chat-back" href={SECTION} ref={back}>
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
                {/* Offered only while there is something to offer: archive
                    is terminal, so once taken the pill beside this is the
                    whole story and there is no route back to put behind a
                    button. */}
                <button
                  className="btn btn-archive chat-archive"
                  type="button"
                  onClick={() => {
                    setArchiveError(undefined);
                    setConfirming(true);
                  }}
                >
                  Archive
                </button>
              </>
            )}
          </>
        )}
      </header>

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
                            <button type="button" onClick={() => retry(message)}>
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
                disabled={session === undefined}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={keyDown}
              />
              <button
                className="btn btn-primary compose-send"
                type="submit"
                disabled={draft.trim() === "" || session === undefined}
              >
                <SendIcon />
                Send
              </button>
            </div>
          </form>
        )}
      </div>

      {confirming ? (
        <Modal
          title="Archive this session?"
          description={<code className="mono-id">{id}</code>}
          dismissible={!archiving}
          returnFocus={back}
          onClose={() => setConfirming(false)}
        >
          <div className="modal-body chat-archive-body">
            <p className="prose">
              The log stays readable and the session keeps every id it was made from, but the
              conversation closes: it takes no further message, and the api has no route back.
            </p>
            <p className="prose">
              A session with a turn in flight is refused — the archive lands after the agent has
              finished what it is working on, not during it.
            </p>
          </div>
          <footer className="modal-foot chat-archive-foot">
            {archiveError ? (
              <p className="form-failure" role="alert">
                {archiveError}
              </p>
            ) : null}
            {/* Focus opens on the way out, not on the way through: this
                dialog asks for something that cannot be undone, so Enter on
                an untouched keyboard must not be the thing that takes it. */}
            <button
              className="btn"
              type="button"
              onClick={() => setConfirming(false)}
              disabled={archiving}
              data-autofocus=""
            >
              Cancel
            </button>
            <button
              className="btn btn-archive"
              type="button"
              onClick={archive}
              disabled={archiving}
            >
              {archiving ? "Archiving…" : "Archive session"}
            </button>
          </footer>
        </Modal>
      ) : null}
    </section>
  );
}
