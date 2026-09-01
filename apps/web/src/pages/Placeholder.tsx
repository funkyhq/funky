// apps/web/src/pages/Placeholder.tsx
// Stands in for every section until each is built. App keys it on the route
// so switching sections remounts it and it animates in.
import type { NavItem } from "../nav";
import "./Placeholder.css";

export function Placeholder({ item }: { item: NavItem }) {
  return (
    <section className="page">
      <span className="page-icon" aria-hidden="true">
        <item.Icon width={24} height={24} strokeWidth={1.6} />
      </span>
      <h1 className="page-title">{item.label}</h1>
      <p className="page-blurb">{item.blurb}</p>
      <span className="page-chip">
        <span className="page-chip-dot" aria-hidden="true" />
        {item.chip}
      </span>
      <p className="page-note">Placeholder — the shell is the first step.</p>
    </section>
  );
}
