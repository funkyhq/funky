// apps/web/src/components/Status.tsx
// The one status a config has. Shared by the resource lists, which all
// front the same lifecycle: a config is live until it is archived, and the
// api has no route back.
import { absoluteTime } from "../lib/format";
import "./Status.css";

/** Archive is the one terminal transition, so this is a state, not a toggle. */
export function Status({ archivedAt }: { archivedAt?: string }) {
  return (
    <span
      className={archivedAt ? "pill pill-archived" : "pill pill-active"}
      title={
        archivedAt
          ? `Archived ${absoluteTime(archivedAt)} — read-only, and no new session can use it`
          : "Accepts updates and new sessions"
      }
    >
      <span className="pill-dot" aria-hidden="true" />
      {archivedAt ? "Archived" : "Active"}
    </span>
  );
}
