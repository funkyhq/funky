// One assistant turn: a single avatar with a stacked column of the agent's reply
// text and its tool calls. Each tool call renders as a "cartridge" — command
// header + output nested inside the same border — instead of loose boxes, so the
// whole turn reads as one indented unit.

import { useState } from "react";

import { Avatar } from "./Avatar";
import { Markdown } from "./Markdown";
import type { ChatItem } from "../types";

type ToolItem = Extract<ChatItem, { kind: "tool" }>;

export function Turn({ items, avatarLetter }: { items: ChatItem[]; avatarLetter: string }) {
  // Many calls in one turn → fold them by default so the turn stays scannable.
  const crowded = items.filter((i) => i.kind === "tool").length >= 3;

  return (
    <div className="turn">
      <Avatar letter={avatarLetter} size={30} fontSize={11} />
      <div className="turn-col">
        {items.map((item) =>
          item.kind === "agent" ? (
            <div key={item.id} className="bubble bubble-agent">
              <Markdown text={item.text} />
            </div>
          ) : item.kind === "tool" ? (
            <Cartridge key={item.id} item={item} crowded={crowded} />
          ) : null,
        )}
      </div>
    </div>
  );
}

function Cartridge({ item, crowded }: { item: ToolItem; crowded: boolean }) {
  const hasOutput = item.output.trim().length > 0;
  const foldable = item.status !== "running" && hasOutput;
  const lineCount = item.output ? item.output.split("\n").length : 0;

  // Default folded only for successful calls in a crowded or long-output turn;
  // errors and the running state stay open so they're never hidden.
  const [collapsed, setCollapsed] = useState(
    foldable && item.status === "done" && (crowded || lineCount > 12),
  );
  const open = foldable && !collapsed;
  const toggle = () => setCollapsed((c) => !c);

  return (
    <div className={`cartridge${item.status === "error" ? " is-error" : ""}`}>
      <div
        className={`cartridge-header${open ? " open" : ""}`}
        role={foldable ? "button" : undefined}
        tabIndex={foldable ? 0 : undefined}
        onClick={foldable ? toggle : undefined}
        onKeyDown={
          foldable
            ? (e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  toggle();
                }
              }
            : undefined
        }
      >
        <span className="tool-chip">{item.name.toUpperCase()}</span>
        <span className="tool-cmd" title={item.command}>
          {item.command}
        </span>
        {!open && hasOutput && (
          <span className="tool-meta">
            {lineCount} line{lineCount === 1 ? "" : "s"}
          </span>
        )}
        {item.status === "running" ? (
          <span className="tool-status running">
            <span className="tool-dots">
              <span />
              <span />
              <span />
            </span>
            RUNNING
          </span>
        ) : (
          <span className={`tool-status ${item.status}`}>
            <span className={`tool-dot ${item.status}`} />
            {item.status === "error" ? "ERROR" : "DONE"}
          </span>
        )}
        {foldable && <span className="tool-fold">{collapsed ? "▸" : "▾"}</span>}
      </div>

      {open && (
        <>
          <div className="cartridge-output">{item.output}</div>
          <div className="cartridge-footer">
            {lineCount} line{lineCount === 1 ? "" : "s"}
          </div>
        </>
      )}
    </div>
  );
}
