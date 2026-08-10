import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, User } from "lucide-react";
import { eventText, sessions as sessApi, streamEvents } from "../lib/api";
import type { Agent, Environment, Session, SessionEvent } from "../lib/types";
import { errMsg, initials, shortId } from "../lib/format";
import { modelLabel } from "../lib/models";
import { Avatar, Badge, Button, Spinner, Textarea } from "../ui/ui";

// A rendered thread item derived from the event log.
type Item =
  | { kind: "user"; seq: number; text: string }
  | { kind: "agent"; seq: number; text: string }
  | { kind: "exec"; seq: number; cmd: string }
  | { kind: "result"; seq: number; output: string; exit: number }
  | { kind: "error"; seq: number; text: string };

function toItems(events: SessionEvent[]): Item[] {
  const items: Item[] = [];
  for (const e of events) {
    if (e.type === "user_message") {
      items.push({ kind: "user", seq: e.seq, text: eventText(e) });
    } else if (e.type === "assistant_message") {
      const text = eventText(e);
      if (text) items.push({ kind: "agent", seq: e.seq, text });
      for (const tc of e.payload.tool_calls ?? []) {
        if (tc.kind === "exec") items.push({ kind: "exec", seq: e.seq, cmd: tc.cmd });
      }
    } else if (e.type === "tool_result") {
      items.push({
        kind: "result",
        seq: e.seq,
        output: e.payload.output ?? "",
        exit: e.payload.exit_code ?? 0,
      });
    } else if (e.type === "turn_failed") {
      items.push({ kind: "error", seq: e.seq, text: e.payload.message ?? "The turn failed." });
    }
  }
  return items;
}

export function Chat({
  session,
  agents,
  environments,
  onBack,
  notify,
}: {
  session: Session;
  agents: Agent[];
  environments: Environment[];
  onBack: () => void;
  notify: (msg: string) => void;
}) {
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const agent = agents.find((a) => a.id === session.agent.id);
  const env = environments.find((e) => e.id === session.environment_id);
  const agentName = agent?.name ?? `agent ${shortId(session.agent.id)}`;
  const model = agent ? modelLabel(agent.model) : "model";

  // Live event stream: replays the whole log from seq 0, then stays live. The log is the
  // source of truth, so both history and new turns flow through here.
  useEffect(() => {
    setEvents([]);
    const close = streamEvents(session.id, (e) => {
      setEvents((prev) => {
        if (prev.some((p) => p.seq === e.seq)) return prev;
        return [...prev, e].sort((a, b) => a.seq - b.seq);
      });
    });
    return close;
  }, [session.id]);

  const items = useMemo(() => toItems(events), [events]);

  // A turn is running when the latest user_message is newer than the latest terminal marker.
  const turnActive = useMemo(() => {
    let lastUser = -1;
    let lastEnd = -1;
    for (const e of events) {
      if (e.type === "user_message") lastUser = Math.max(lastUser, e.seq);
      if (e.type === "turn_completed" || e.type === "turn_failed")
        lastEnd = Math.max(lastEnd, e.seq);
    }
    return lastUser > lastEnd;
  }, [events]);

  // Once the stream confirms the turn is live, drop our local "sending" latch.
  useEffect(() => {
    if (turnActive) setSending(false);
  }, [turnActive]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [items.length, turnActive]);

  const busy = sending || turnActive;

  async function send() {
    const text = draft.trim();
    if (!text || busy) return;
    setSending(true);
    setDraft("");
    try {
      // If the sandbox is still provisioning (session opened before session_provisioned),
      // wait so the first append doesn't race provisioning.
      if (!events.some((e) => e.type === "session_provisioned")) {
        const ready = await sessApi.waitReady(session.id);
        if (ready.status === "failed")
          throw new Error("The session failed to provision its sandbox.");
      }
      await sessApi.sendMessage(session.id, text);
    } catch (e) {
      setSending(false);
      setDraft(text);
      notify(errMsg(e));
    }
  }

  function onKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }

  return (
    <div className="chat">
      <div className="chat__head">
        <button type="button" className="chat__back" onClick={onBack} aria-label="Back">
          <ChevronLeft size={18} />
        </button>
        <Avatar initials={initials(agentName)} size={38} />
        <div style={{ minWidth: 0 }}>
          <div className="chat__name">{agentName}</div>
          <div className="chat__sub">
            {shortId(session.id)} · {model} · {env?.name ?? shortId(session.environment_id)}
          </div>
        </div>
        <div style={{ marginLeft: "auto" }}>
          <SessionBadge session={session} turnActive={turnActive} />
        </div>
      </div>

      <div className="chat__scroll" ref={scrollRef}>
        <div className="chat__thread">
          {items.map((it) => (
            <ThreadItem key={`${it.seq}-${it.kind}`} item={it} agentName={agentName} />
          ))}
          {busy ? (
            <div className="msg" data-role="agent">
              <span className="msg__avatar msg__avatar--agent">{initials(agentName)}</span>
              <div className="msg__bubble msg__bubble--agent">
                <span className="msg__thinking">
                  <Spinner size={15} /> Thinking…
                </span>
              </div>
            </div>
          ) : null}
        </div>
      </div>

      <div className="chat__composer">
        <div className="chat__composer-inner">
          <Textarea
            rows={2}
            placeholder="Message your agent…  (Enter to send)"
            value={draft}
            onChange={setDraft}
            onKeyDown={onKey}
          />
          <Button variant="accent" disabled={busy || !draft.trim()} onClick={() => void send()}>
            Send
          </Button>
        </div>
      </div>
    </div>
  );
}

function ThreadItem({ item, agentName }: { item: Item; agentName: string }) {
  if (item.kind === "exec") {
    return (
      <div className="activity">
        <div className="activity__cmd">$ {item.cmd}</div>
      </div>
    );
  }
  if (item.kind === "result") {
    if (!item.output.trim()) return null;
    return (
      <div className="activity">
        <div className="activity__out">{item.output}</div>
      </div>
    );
  }
  const isUser = item.kind === "user";
  const isError = item.kind === "error";
  return (
    <div className="msg" data-role={isUser ? "user" : "agent"}>
      <span className={`msg__avatar ${isUser ? "msg__avatar--user" : "msg__avatar--agent"}`}>
        {/* Funky has no per-user identity, so show a generic glyph rather than a fake name. */}
        {isUser ? <User size={17} /> : initials(agentName)}
      </span>
      <div className={`msg__bubble ${isUser ? "msg__bubble--user" : "msg__bubble--agent"}`}>
        <span className="msg__text" style={isError ? { color: "var(--red-700)" } : undefined}>
          {item.text}
        </span>
      </div>
    </div>
  );
}

function SessionBadge({ session, turnActive }: { session: Session; turnActive: boolean }) {
  if (turnActive)
    return (
      <Badge tone="green" dot>
        running
      </Badge>
    );
  if (session.status === "failed")
    return (
      <Badge tone="red" dot>
        failed
      </Badge>
    );
  if (session.status === "archived") return <Badge tone="neutral">archived</Badge>;
  if (session.status === "provisioning")
    return (
      <Badge tone="neutral" dot>
        provisioning
      </Badge>
    );
  return (
    <Badge tone="green" dot>
      ready
    </Badge>
  );
}
