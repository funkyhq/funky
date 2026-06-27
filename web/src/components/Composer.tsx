// The bottom input bar. Enter sends; Shift+Enter inserts a newline. The textarea
// auto-grows to a few lines. While unfocused it shows just the placeholder (no
// cursor); on focus the placeholder clears and the native blue cursor blinks at
// the insertion point (the tail of what you've typed).

import { useEffect, useRef } from "react";

interface ComposerProps {
  value: string;
  disabled: boolean;
  onChange: (text: string) => void;
  onSend: () => void;
}

export function Composer({ value, disabled, onChange, onSend }: ComposerProps) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const canSend = !disabled && value.trim().length > 0;

  // Auto-grow the textarea up to its CSS max-height.
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${ta.scrollHeight}px`;
  }, [value]);

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (canSend) onSend();
    }
  }

  return (
    <div className="composer">
      <div className="composer-field">
        <textarea
          ref={taRef}
          className="composer-input"
          rows={1}
          aria-label="Message"
          placeholder="Type your message…"
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
        />
      </div>
      <button className="btn-primary send" onClick={onSend} disabled={!canSend}>
        SEND
      </button>
    </div>
  );
}
