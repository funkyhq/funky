// apps/web/src/lib/curl.ts
// The quickstart's calls as curl, for the panel beside the walk: one call
// per step, written the way the README's curl walk writes them, so what the
// panel shows can be pasted into a terminal and does what that step does.
//
// The token is a placeholder on purpose. The console never holds it — the
// dev server's proxy attaches it (see lib/api.ts) — so the panel says where
// it comes from instead of showing it.
import type { CreateAgentConfigInput } from "./api";

/** The api as the README addresses it: where compose publishes it. */
const API = "localhost:3000";

/** The auth every call below reads, as shell variables. */
export const PRELUDE = [
  "export TOKEN=<your FUNKY_AUTH_TOKEN>",
  'export H="Authorization: Bearer $TOKEN"',
  'export J="content-type: application/json"',
].join("\n");

/** Text as one single-quoted shell word. A quote inside closes the word,
 *  adds an escaped quote, and reopens it — so a system prompt that says
 *  "you're" pastes as written. */
const quoted = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;

// Each call breaks its flags onto continuation lines: the panel is narrower
// than a README line, and a wrap of its own would split `-H` from its value.

/** Step 1: the agent config, keeping its id as $AID for the step after. */
export const agentConfigCall = (input: CreateAgentConfigInput) =>
  `AID=$(curl -s ${API}/v1/agent-configs \\\n` +
  `  -H "$H" -H "$J" \\\n` +
  `  -d ${quoted(JSON.stringify(input, null, 2))} | jq -r .id)`;

/** Step 2: the task — a session on $AID's latest version, started with
 *  its content as the first message — keeping the session's id as $SID,
 *  where its log is. The body is single-quoted pieces around "$AID", which
 *  the shell joins into one word: the id expands, and the content pastes
 *  as written. */
export const taskCall = (text: string) =>
  `SID=$(curl -s ${API}/v1/tasks \\\n` +
  `  -H "$H" -H "$J" \\\n` +
  `  -d ${quoted('{"agentConfigId":"')}"$AID"${quoted(`","content":${JSON.stringify(text)}}`)} | jq -r .sessionId)`;
