// apps/web/src/components/ProviderKeys.tsx
// Every provider the worker can serve, beside the env var that would give
// this stack a key for it. What both surfaces that write an agent config
// show when there is no provider to offer — the list is the same fact in
// each, so it is one list; the sentence leading into it is not, and stays
// with whoever is saying it.
import { KNOWN_PROVIDERS } from "../lib/providers";
import "./ProviderKeys.css";

export function ProviderKeys() {
  return (
    <ul className="key-list">
      {KNOWN_PROVIDERS.map((provider) => (
        <li key={provider.id}>
          <code>{provider.envKey}</code>
          <span>{provider.label}</span>
        </li>
      ))}
    </ul>
  );
}
