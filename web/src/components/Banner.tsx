// A transient toast for orchestration errors not tied to a conversation
// (e.g. a failed "new session"). Pinned to the top center of the window.

export function Banner({ text, onClose }: { text: string; onClose: () => void }) {
  return (
    <div className="banner" role="alert">
      <span className="banner-text">⚠ {text}</span>
      <button className="banner-close" onClick={onClose} aria-label="Dismiss">
        X
      </button>
    </div>
  );
}
