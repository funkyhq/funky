// apps/web/src/components/Status.tsx
// The one lifecycle every resource in this console shares: a row is live
// until it is archived, and the api has no route back. What archiving
// COSTS differs by resource, and that wording lives in lib/status.ts —
// the config lists take the default, and the session pages pass their own.
import { absoluteTime } from "../lib/format";
import { CONFIG_STATUS, type StatusMeaning } from "../lib/status";
import "./Status.css";

/** Archive is the one terminal transition, so this is a state, not a toggle. */
export function Status({
  archivedAt,
  meaning = CONFIG_STATUS,
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
