// apps/web/src/components/Status.tsx
// The one lifecycle every resource in this console shares: a row is live
// until it is archived, and the api has no route back. What archiving
// COSTS differs by resource, and that wording lives in lib/status.ts.
//
// Two components, because only a config has a word for the live half. A
// config list draws both states with Status. A session page draws
// Archived alone: "Active" on a session would say it has an open work
// item, which is not what "not archived" means (lib/status.ts).
import { absoluteTime } from "../lib/format";
import { CONFIG_STATUS, type StatusMeaning } from "../lib/status";
import "./Status.css";

/** The archived pill. `meaning` reads as a clause after "Archived <when> — ". */
export function Archived({ archivedAt, meaning }: { archivedAt: string; meaning: string }) {
  return (
    <span
      className="pill pill-archived"
      title={`Archived ${absoluteTime(archivedAt)} — ${meaning}`}
    >
      <span className="pill-dot" aria-hidden="true" />
      Archived
    </span>
  );
}

/** A config's lifecycle. Archive is the one terminal transition, so this
 *  is a state, not a toggle. */
export function Status({
  archivedAt,
  meaning = CONFIG_STATUS,
}: {
  archivedAt?: string;
  meaning?: StatusMeaning;
}) {
  if (archivedAt) return <Archived archivedAt={archivedAt} meaning={meaning.archived} />;
  return (
    <span className="pill pill-active" title={meaning.active}>
      <span className="pill-dot" aria-hidden="true" />
      Active
    </span>
  );
}
