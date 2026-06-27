// The Create-Agent modal (design Screen 1). Pre-filled with the design's
// "Funkbot" sample so a first-time user can hit CREATE and land on the reference
// chat. Closes on CANCEL, the X, the overlay, or Escape. CREATE validates a
// non-empty name + a selected model, calls the backend, and shows any error
// inline while keeping the modal open.

import { useEffect, useState } from "react";

import { describeError } from "../api/client";
import { DEFAULT_MODEL, MODELS } from "../lib/models";
import type { CreateAgentDraft } from "../state/useFunkyStore";

const SAMPLE_PROMPT =
  "You are Funkbot, a cheerful retro arcade guide. Keep replies short, upbeat, and a little 8-bit.";

interface CreateAgentModalProps {
  onClose: () => void;
  onCreate: (draft: CreateAgentDraft) => Promise<void>;
}

export function CreateAgentModal({ onClose, onCreate }: CreateAgentModalProps) {
  const [name, setName] = useState("Funkbot");
  const [modelId, setModelId] = useState(DEFAULT_MODEL.id);
  const [systemPrompt, setSystemPrompt] = useState(SAMPLE_PROMPT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canCreate = name.trim().length > 0 && !!modelId && !busy;

  // Close on Escape.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !busy) onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, busy]);

  async function submit() {
    if (!canCreate) return;
    setBusy(true);
    setError(null);
    try {
      await onCreate({ name: name.trim(), modelId, systemPrompt });
      // On success, onCreate closes the modal.
    } catch (err) {
      setError(describeError(err, "Couldn't create the agent. Is the client running?"));
      setBusy(false);
    }
  }

  return (
    <div
      className="overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div className="modal" role="dialog" aria-modal="true" aria-label="New agent">
        <div className="modal-header">
          <div className="modal-title">NEW AGENT</div>
          <button className="modal-close" onClick={onClose} aria-label="Close" disabled={busy}>
            X
          </button>
        </div>

        <div className="modal-body">
          <label className="field-label" htmlFor="agent-name">
            NAME
          </label>
          <div className="text-field">
            <input
              id="agent-name"
              className="text-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </div>

          <div className="field-label">MODEL</div>
          <div className="model-row">
            {MODELS.map((m) => (
              <button
                key={m.id}
                type="button"
                className={`model-option${modelId === m.id ? " selected" : ""}`}
                onClick={() => setModelId(m.id)}
              >
                {m.label}
              </button>
            ))}
          </div>

          <label className="field-label" htmlFor="agent-prompt">
            SYSTEM PROMPT
          </label>
          <textarea
            id="agent-prompt"
            className="prompt-input"
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
          />

          {error && <div className="modal-error">⚠ {error}</div>}

          <div className="modal-actions">
            <button className="btn-secondary" type="button" onClick={onClose} disabled={busy}>
              CANCEL
            </button>
            <button className="btn-primary" type="button" onClick={submit} disabled={!canCreate}>
              {busy ? "CREATING…" : "CREATE ▶"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
