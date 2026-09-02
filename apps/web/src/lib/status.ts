// apps/web/src/lib/status.ts
// What the lifecycle pill MEANS, per resource.
//
// Every row this console lists shares one lifecycle — live until archived,
// and archive is terminal with no route back — so one component draws it
// (components/Status.tsx). What archiving COSTS is the resource's own: a
// config stops taking updates, a session stops taking messages. That
// wording is here rather than in the component because two pages front the
// same session row and must not describe it differently, and because a
// component file that also exports constants gives up fast refresh.

/** What each state means for the row it marks. `archived` reads as a clause
 *  after "Archived <when> — ". */
export type StatusMeaning = { active: string; archived: string };

/** The two config lists', which share one rule between them. */
export const CONFIG_STATUS: StatusMeaning = {
  active: "Accepts updates and new sessions",
  archived: "read-only, and no new session can use it",
};

/** A session's, which is not that: archiving one closes client writes
 *  rather than edits, and leaves a log that stays readable. */
export const SESSION_STATUS: StatusMeaning = {
  active: "Accepts messages, and a worker can pick its work up",
  archived: "read-only: it takes no new message, and its log stays readable",
};
