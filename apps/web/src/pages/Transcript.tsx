// apps/web/src/pages/Transcript.tsx
// The session log as a conversation: what the user said, what the model
// answered, and — folded away — the work it did in between.
//
// Everything here is IN the log. A message this client has sent that the
// log doesn't hold yet is not part of the transcript and isn't drawn as
// one; it waits by the composer that sent it (see the queue in
// SessionDetail.tsx).
//
// The log carries more than a chat does. Thinking blocks, tool calls and
// tool results are all real rows of it, and dropping them would make the
// transcript claim the model answered out of nowhere; showing them expanded
// would bury the answer. Each is a native <details>, so the summary is one
// line, the payload is one click, and no state here decides which.
//
// A type this file doesn't know is marked, never skipped silently: the log
// is append-only and additive by design, so an unknown row means a reader
// that is behind — which is worth saying rather than hiding.
import type {
  AssistantMessage,
  SessionEntry,
  TextContent,
  ToolResultMessage,
  UserMessage,
} from "../lib/api";
import { absoluteTime, relativeTime } from "../lib/format";
import { Markdown } from "../components/Markdown";
import "./Transcript.css";

/** The plain text of a message's content, which is all a bubble shows.
 *  Images are named rather than drawn — the log stores them base64, and a
 *  transcript is not a gallery. */
function textOf(message: UserMessage | ToolResultMessage): string {
  return message.content
    .map((part) => (part.type === "text" ? part.text : `[${part.mimeType}]`))
    .join("\n");
}

/** How a turn ended, when that is not simply "it answered". Tool use is the
 *  ordinary middle of a turn and says nothing worth a line. */
function outcomeOf(message: AssistantMessage): string | undefined {
  switch (message.stopReason) {
    case "max_tokens":
      return "Stopped at the token limit";
    case "aborted":
      return "Cancelled";
    case "error":
      return message.errorMessage ?? "The turn failed";
    default:
      return undefined;
  }
}

function Time({ at, now }: { at: string; now: number }) {
  return (
    <time className="turn-time" dateTime={at} title={absoluteTime(at)}>
      {relativeTime(at, now)}
    </time>
  );
}

/** One assistant turn: its text as prose, with the thinking and the calls
 *  that produced it folded above it. */
function Assistant({ message }: { message: AssistantMessage }) {
  const text = message.content.filter((part): part is TextContent => part.type === "text");
  const outcome = outcomeOf(message);
  return (
    <>
      {message.content.map((part, index) =>
        part.type === "thinking" ? (
          <details className="fold" key={index}>
            <summary className="fold-head">
              {part.thinking === "" ? "Thinking (redacted by the provider)" : "Thinking"}
            </summary>
            {part.thinking === "" ? null : <p className="fold-body">{part.thinking}</p>}
          </details>
        ) : part.type === "toolCall" ? (
          <details className="fold" key={index}>
            <summary className="fold-head">
              Called <span className="fold-name">{part.name}</span>
            </summary>
            <pre className="fold-body">{JSON.stringify(part.arguments, null, 2)}</pre>
          </details>
        ) : null,
      )}
      {/* Markdown, because that is what a model writes: fences, lists and
          emphasis are the shape of the answer, not decoration on it. A
          USER bubble stays literal text — nobody typing into a chat box
          means their asterisks as italics. */}
      {text.map((part, index) => (
        <Markdown text={part.text} key={index} />
      ))}
      {outcome === undefined ? null : (
        <p className={message.stopReason === "error" ? "turn-outcome bad" : "turn-outcome"}>
          {outcome}
        </p>
      )}
    </>
  );
}

/** One entry, as a line of the conversation or as the aside that stands in
 *  for one. */
function Entry({ entry, now }: { entry: SessionEntry; now: number }) {
  // Everything that is not a message, INCLUDING what this reader has never
  // heard of. The wire types are hand-mirrored and the json is cast, not
  // validated, so a newer api adding an entry type reaches here typed as
  // something it isn't — and reading `entry.message` off it would take the
  // whole transcript down. The log is additive by design, so this case is
  // expected rather than exceptional, and the last branch is what the
  // compiler calls unreachable and the network calls Tuesday.
  if (entry.type !== "message") {
    return (
      <p className="aside">
        {entry.type === "control"
          ? "Cancel requested"
          : entry.type === "compaction"
            ? `Compacted through #${entry.upToSeq}`
            : entry.type === "custom"
              ? `Custom entry (${entry.namespace})`
              : "An entry this console doesn't know yet"}
      </p>
    );
  }

  const { message } = entry;
  if (message.role === "user") {
    return (
      <div className="turn turn-user">
        <div className="bubble bubble-user">{textOf(message)}</div>
        <Time at={entry.timestamp} now={now} />
      </div>
    );
  }
  if (message.role === "toolResult") {
    return (
      <details className={message.isError ? "fold fold-error" : "fold"}>
        <summary className="fold-head">
          {message.isError ? "Failed" : "Result"} from{" "}
          <span className="fold-name">{message.toolName}</span>
        </summary>
        <pre className="fold-body">{textOf(message)}</pre>
      </details>
    );
  }
  // Same rule one level down: a role this console doesn't know is marked,
  // not rendered as an assistant turn whose fields it would then be reading
  // off a message that hasn't got them.
  if (message.role !== "assistant") {
    return <p className="aside">A message this console doesn&rsquo;t know yet</p>;
  }
  return (
    <div className="turn turn-agent">
      <div className="bubble bubble-agent">
        <Assistant message={message} />
      </div>
      <span className="turn-meta">
        <span className="turn-model">{message.model}</span>
        <Time at={entry.timestamp} now={now} />
      </span>
    </div>
  );
}

export function Transcript({ entries, now }: { entries: SessionEntry[]; now: number }) {
  return (
    <>
      {entries.map((entry) => (
        <Entry entry={entry} key={entry.id} now={now} />
      ))}
    </>
  );
}
