// apps/web/src/components/Status.tsx
// The one lifecycle every resource in this console shares: a row is live
// until it is archived, and the api has no route back. What archiving
// COSTS differs by resource, though — a config stops taking updates, a
// session stops taking messages — so the pill is shared and the hover
// text that explains it is the list's own.
import { absoluteTime } from "../lib/format";
import "./Status.css";

/** What each state means for the row it marks. `archived` reads as a clause
 *  after "Archived <when> — ". */
export type StatusMeaning = { active: string; archived: string };

/** The config lists' meaning, and the default because both of them front
 *  the same rule. A session's archive costs something else, so that list
 *  passes its own (pages/Sessions.tsx). */
const CONFIG: StatusMeaning = {
  active: "Accepts updates and new sessions",
  archived: "read-only, and no new session can use it",
};

/** Archive is the one terminal transition, so this is a state, not a toggle. */
export function Status({
  archivedAt,
  meaning = CONFIG,
}: {
  archivedAt?: string;
  meaning?: StatusMeaning;
}) {
  return (
    <span
      className={archivedAt ? "pill pill-archived" : "pill pill-active"}
      title={
        archivedAt ? `Archived ${absoluteTime(archivedAt)} — ${meaning.archived}` : meaning.active
      }
    >
      <span className="pill-dot" aria-hidden="true" />
      {archivedAt ? "Archived" : "Active"}
    </span>
  );
}
