// Shown when there are no agents yet (before design Screen 2): the mascot and a
// nudge to create the first agent. The modal it opens is pre-filled with the
// design's "Funkbot" sample, so the first create reproduces the reference UI.

import { Mascot } from "./Mascot";

export function FirstRun({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="empty-state">
      <Mascot />
      <div className="empty-title">WELCOME TO FUNKY</div>
      <div className="empty-sub">
        Create your first agent to start chatting — name it, pick a model, and give it a system prompt.
      </div>
      <button className="btn-primary" onClick={onCreate}>
        + NEW AGENT
      </button>
    </div>
  );
}
