// The Funky shell: a fixed Agents sidebar on the left and a main column that is
// either the chat (tabs + conversation + composer) when an agent is active, or
// the first-run prompt when there are none yet. The Create-Agent modal and a
// transient error toast overlay the whole thing.

import { Banner } from "./components/Banner";
import { Composer } from "./components/Composer";
import { Conversation } from "./components/Conversation";
import { CreateAgentModal } from "./components/CreateAgentModal";
import { FirstRun } from "./components/FirstRun";
import { Sidebar } from "./components/Sidebar";
import { SessionTabs } from "./components/SessionTabs";
import { useFunkyStore } from "./state/useFunkyStore";

export default function App() {
  const { state, activeAgent, activeSession, actions } = useFunkyStore();

  return (
    <div className="app">
      <Sidebar
        agents={state.agents}
        activeAgentId={state.activeAgentId}
        onSelectAgent={actions.selectAgent}
        onNewAgent={actions.openModal}
        onReset={actions.reset}
      />

      <main className="main">
        {activeAgent && activeSession ? (
          <>
            <SessionTabs
              agent={activeAgent}
              activeSessionId={activeAgent.activeSessionId}
              onSelectSession={(sessionId) => actions.selectSession(activeAgent.id, sessionId)}
              onNewSession={() => actions.createSession(activeAgent.id)}
            />
            <Conversation agent={activeAgent} session={activeSession} />
            <Composer
              value={activeSession.composer}
              disabled={activeSession.typing}
              onChange={(text) => actions.setComposer(activeAgent.id, activeSession.id, text)}
              onSend={actions.sendMessage}
            />
          </>
        ) : (
          <FirstRun onCreate={actions.openModal} />
        )}
      </main>

      {state.modalOpen && (
        <CreateAgentModal onClose={actions.closeModal} onCreate={actions.createAgent} />
      )}

      {state.banner && <Banner text={state.banner} onClose={actions.clearBanner} />}
    </div>
  );
}
