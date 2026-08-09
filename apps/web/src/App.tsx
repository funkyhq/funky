import { useCallback, useEffect, useRef, useState } from "react";
import { errMsg } from "./lib/format";
import { Spinner } from "./ui/ui";
import { HealthGate, Sidebar } from "./console/parts";
import type { Tab } from "./console/parts";
import { useConsoleData, useHealth } from "./console/data";
import { QuickStart } from "./console/QuickStart";
import { Agents } from "./console/Agents";
import { Environments } from "./console/Environments";
import { Sessions } from "./console/Sessions";
import { Chat } from "./console/Chat";
import "./console/console.css";

export default function App() {
  const { status, retry } = useHealth();
  const data = useConsoleData();
  const [tab, setTab] = useState<Tab>("quickstart");
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);

  const notify = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 4500);
  }, []);

  // Load the entity lists once the backend becomes reachable. Keyed on `status` only —
  // reloadAll/notify are stable, and we deliberately reload on the checking→ok transition.
  const reloadAll = data.reloadAll;
  useEffect(() => {
    if (status === "ok") reloadAll().catch((e) => notify(errMsg(e)));
  }, [status, reloadAll, notify]);

  const selectTab = useCallback((t: Tab) => {
    setTab(t);
    if (t === "sessions") setActiveSessionId(null);
  }, []);

  const openSession = useCallback((id: string) => {
    setActiveSessionId(id);
    setTab("sessions");
  }, []);

  const launchFromQuickStart = useCallback(
    async (sessionId: string) => {
      await data.reloadAll().catch(() => {});
      setActiveSessionId(sessionId);
      setTab("sessions");
    },
    [data],
  );

  if (status === "checking") {
    return (
      <div className="splash">
        <Spinner /> Connecting to the Funky API…
      </div>
    );
  }

  const activeSession = activeSessionId
    ? data.sessions.find((s) => s.id === activeSessionId)
    : undefined;

  return (
    <div className="console">
      <Sidebar tab={tab} onSelect={selectTab} />
      <main className="main">
        {tab === "sessions" && activeSessionId ? (
          activeSession ? (
            <Chat
              session={activeSession}
              agents={data.agents}
              environments={data.environments}
              onBack={() => setActiveSessionId(null)}
              notify={notify}
            />
          ) : (
            <div className="splash">
              <Spinner /> Loading session…
            </div>
          )
        ) : tab === "sessions" ? (
          <Sessions
            sessions={data.sessions}
            agents={data.agents}
            environments={data.environments}
            reload={data.reloadSessions}
            onOpen={openSession}
            notify={notify}
          />
        ) : (
          <div className="scroll">
            {tab === "quickstart" ? <QuickStart onLaunch={launchFromQuickStart} /> : null}
            {tab === "agents" ? (
              <Agents agents={data.agents} reload={data.reloadAgents} notify={notify} />
            ) : null}
            {tab === "environments" ? (
              <Environments
                environments={data.environments}
                reload={data.reloadEnvironments}
                notify={notify}
              />
            ) : null}
          </div>
        )}
      </main>

      {status === "down" ? <HealthGate onRetry={retry} /> : null}
      {toast ? <div className="toast">{toast}</div> : null}
    </div>
  );
}
