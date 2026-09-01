// apps/web/src/components/Sidebar.tsx
// The console's one persistent surface: brand, sections, namespace. Items
// are real anchors so the browser handles history and keyboard; the only
// state here is the measured position of the active-item rail, which slides
// between items instead of blinking on and off.
import { useLayoutEffect, useRef, useState } from "react";
import type { NavItem } from "../nav";
import "./Sidebar.css";

type Rail = { top: number; height: number };

/**
 * Scrolls the nav so the active item sits inside it. A deep link at a narrow
 * width lands with the horizontal nav at scrollLeft 0 and the active section
 * possibly past the right edge. Done by hand rather than with scrollIntoView
 * so only the nav ever moves — scrollIntoView also scrolls the page.
 */
const REVEAL_INSET = 12;

function reveal(nav: HTMLElement, item: HTMLElement | null): void {
  if (!item || nav.scrollWidth <= nav.clientWidth) return;
  const navBox = nav.getBoundingClientRect();
  const box = item.getBoundingClientRect();
  if (box.left < navBox.left + REVEAL_INSET) {
    nav.scrollLeft -= navBox.left + REVEAL_INSET - box.left;
  } else if (box.right > navBox.right - REVEAL_INSET) {
    nav.scrollLeft += box.right - (navBox.right - REVEAL_INSET);
  }
}

export function Sidebar({
  items,
  activeId,
  namespace,
}: {
  items: NavItem[];
  activeId: string;
  namespace: string;
}) {
  const navRef = useRef<HTMLElement>(null);
  const [rail, setRail] = useState<Rail | null>(null);

  // The rail's position and the nav's scroll both derive from layout, so they
  // are re-derived together — on mount, on route change, and on every resize.
  // Resizing matters on its own: crossing into the narrow row layout can leave
  // the active item past the nav's right edge without activeId ever changing.
  useLayoutEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    const sync = () => {
      const active = nav.querySelector<HTMLElement>('[aria-current="page"]');
      setRail(active ? { top: active.offsetTop, height: active.offsetHeight } : null);
      reveal(nav, active);
    };
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(nav);
    return () => observer.disconnect();
  }, [activeId]);

  return (
    <aside className="sidebar">
      <div className="sidebar-glow" aria-hidden="true" />

      <div className="sidebar-head">
        <img className="brand-mark" src="/logo.svg" width={30} height={30} alt="" />
        <span className="brand-text">
          <span className="brand-name">Funky</span>
          <span className="brand-sub">Console</span>
        </span>
      </div>

      <nav className="nav" ref={navRef} aria-label="Sections">
        <span
          className="nav-rail"
          aria-hidden="true"
          style={
            rail ? { transform: `translateY(${rail.top}px)`, height: rail.height } : { opacity: 0 }
          }
        />
        {items.map((item, i) => (
          <div className="nav-slot" key={item.id}>
            {item.groupLabel ? <span className="nav-group">{item.groupLabel}</span> : null}
            <a
              className="nav-item"
              href={`#/${item.id}`}
              aria-current={item.id === activeId ? "page" : undefined}
              style={{ animationDelay: `${60 + i * 45}ms` }}
            >
              <item.Icon className="nav-icon" />
              <span className="nav-label">{item.label}</span>
            </a>
          </div>
        ))}
      </nav>

      <div className="sidebar-foot">
        <div
          className="ns"
          title="The api takes a namespace per request; the console addresses this one."
        >
          <span className="ns-mark" aria-hidden="true">
            {namespace.slice(0, 1)}
          </span>
          <span className="ns-text">
            <span className="ns-label">Namespace</span>
            <span className="ns-value">{namespace}</span>
          </span>
        </div>
      </div>
    </aside>
  );
}
