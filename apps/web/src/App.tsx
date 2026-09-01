// apps/web/src/App.tsx
// The console shell: a persistent sidebar beside one routed pane. Sections
// live in nav.ts; the route is the URL hash, so every section is linkable.
import { useEffect } from "react";
import { Sidebar } from "./components/Sidebar";
import { ExternalLinkIcon } from "./components/Icons";
import { Placeholder } from "./pages/Placeholder";
import { useHashRoute } from "./lib/useHashRoute";
import { DEFAULT_NAMESPACE } from "./lib/api";
import { DEFAULT_ROUTE, NAV_ITEMS, resolveNavItem } from "./nav";
import "./App.css";

const REPO_URL = "https://github.com/funkyhq/funky#readme";

function App() {
  const active = resolveNavItem(useHashRoute());

  // Land on a real route so the first view is shareable. replaceState keeps
  // it out of history; the active item already resolves to the same section.
  useEffect(() => {
    if (!window.location.hash) {
      window.history.replaceState(null, "", `#/${DEFAULT_ROUTE}`);
    }
  }, []);

  return (
    <div className="app">
      <Sidebar items={NAV_ITEMS} activeId={active.id} namespace={DEFAULT_NAMESPACE} />

      <main className="main">
        <header className="topbar">
          <span className="topbar-title">{active.label}</span>
          <a className="topbar-link" href={REPO_URL} target="_blank" rel="noreferrer">
            <ExternalLinkIcon />
            Docs
          </a>
        </header>

        <div className="content">
          <Placeholder key={active.id} item={active} />
        </div>
      </main>
    </div>
  );
}

export default App;
