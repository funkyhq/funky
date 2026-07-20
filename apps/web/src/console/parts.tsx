import type { ReactNode } from 'react'
import { useState } from 'react'
import { AlertTriangle, Archive, Cpu, Layers, MessageSquare, MoreVertical, X, Zap } from 'lucide-react'
import { Button, Select, Textarea } from '../ui/ui'
import { ANTHROPIC_ENABLED, MODEL_OPTIONS } from '../lib/models'
import type { NetworkMode } from '../lib/network'
import { useClickOutside } from './data'

export type Tab = 'quickstart' | 'agents' | 'sessions' | 'environments'

const NAV: { id: Tab; label: string; icon: ReactNode }[] = [
  { id: 'quickstart', label: 'Quick Start', icon: <Zap size={19} /> },
  { id: 'agents', label: 'Agents', icon: <Cpu size={19} /> },
  { id: 'sessions', label: 'Sessions', icon: <MessageSquare size={19} /> },
  { id: 'environments', label: 'Environments', icon: <Layers size={19} /> },
]

export function Sidebar({ tab, onSelect }: { tab: Tab; onSelect: (t: Tab) => void }) {
  return (
    <aside className="sidebar">
      <div className="sidebar__brand">
        <span className="sidebar__wordmark">FUNKY</span>
      </div>
      {NAV.map((n) => (
        <button
          key={n.id}
          type="button"
          className="nav"
          data-active={tab === n.id || undefined}
          onClick={() => onSelect(n.id)}
        >
          {n.icon}
          {n.label}
        </button>
      ))}
    </aside>
  )
}

export function PageHeader({
  title,
  subtitle,
  action,
}: {
  title: string
  subtitle: string
  action?: ReactNode
}) {
  return (
    <div className="head-row">
      <div className="head-row__titles">
        <h1 className="page-title">{title}</h1>
        <p className="page-sub">{subtitle}</p>
      </div>
      {action}
    </div>
  )
}

/** One shared shape for every "no items yet" page: icon · title · subtitle. */
export function EmptyState({
  icon,
  title,
  subtitle,
}: {
  icon: ReactNode
  title: string
  subtitle: string
}) {
  return (
    <div className="empty">
      <span className="empty__icon">{icon}</span>
      <h3>{title}</h3>
      <p>{subtitle}</p>
    </div>
  )
}

/**
 * The Model picker. With an ANTHROPIC_API_KEY present it offers the Claude models; without
 * one there's nothing usable to pick, so it points the user at their .env instead.
 */
export function ModelField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  if (!ANTHROPIC_ENABLED) {
    return (
      <div className="field">
        <span className="field__label">Model</span>
        <p className="model-hint">
          Please specify <code>ANTHROPIC_API_KEY</code> in your <code>.env</code> file.
        </p>
      </div>
    )
  }
  return (
    <Select
      label="Model"
      value={value}
      options={MODEL_OPTIONS.map((m) => ({ value: m.label, label: m.label }))}
      onChange={onChange}
    />
  )
}

// How the agent runs its turns. claude-code (the harness) requires an anthropic model,
// which the UI's model picker always is — so the choice is always valid here.
export function RuntimeField({
  value,
  onChange,
}: {
  value: 'native' | 'claude-code'
  onChange: (v: 'native' | 'claude-code') => void
}) {
  return (
    <div className="field">
      <Select
        label="Runtime"
        value={value}
        options={[
          { value: 'native', label: 'Native — Funky’s built-in agent loop' },
          { value: 'claude-code', label: 'Claude Code — run turns inside the Claude Agent SDK' },
        ]}
        onChange={(v) => onChange(v as 'native' | 'claude-code')}
      />
      {value === 'claude-code' ? (
        <p className="model-hint">
          Runs each turn inside Claude Code; needs <code>ANTHROPIC_API_KEY</code> on the worker.
        </p>
      ) : null}
    </div>
  )
}

export function NetworkFields({
  mode,
  allowedHosts,
  onModeChange,
  onAllowedHostsChange,
}: {
  mode: NetworkMode
  allowedHosts: string
  onModeChange: (mode: NetworkMode) => void
  onAllowedHostsChange: (hosts: string) => void
}) {
  return (
    <>
      <Select
        label="Network access"
        value={mode}
        options={[
          { value: 'unrestricted', label: 'Unrestricted — allow all outbound traffic' },
          { value: 'limited', label: 'Limited — only allow selected hosts' },
        ]}
        onChange={(value) => onModeChange(value as NetworkMode)}
      />
      {mode === 'limited' ? (
        <div className="network-hosts">
          <Textarea
            label="Allowed hosts"
            rows={2}
            placeholder="api.example.com, *.example.org"
            value={allowedHosts}
            onChange={onAllowedHostsChange}
          />
          <p className="field-hint">Separate hosts with commas or new lines. Leave empty to deny all outbound access.</p>
        </div>
      ) : null}
    </>
  )
}

/** A three-dots menu button. `children` renders the menu items and receives a `close` fn. */
export function Kebab({ children }: { children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false)
  const ref = useClickOutside<HTMLDivElement>(open, () => setOpen(false))
  return (
    <div className="kebab" ref={ref}>
      <button
        type="button"
        className="kebab__btn"
        onClick={() => setOpen((v) => !v)}
        aria-label="More"
      >
        <MoreVertical size={18} />
      </button>
      {open ? <div className="kebab__menu">{children(() => setOpen(false))}</div> : null}
    </div>
  )
}

export function ArchiveItem({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className="kebab__item" onClick={onClick}>
      <Archive size={16} />
      Archive
    </button>
  )
}

export function SelectionBar({
  count,
  onClear,
  onArchive,
}: {
  count: number
  onClear: () => void
  onArchive: () => void
}) {
  if (count === 0) return null
  return (
    <div className="selbar">
      <span className="selbar__count">{count} selected</span>
      <button type="button" className="selbar__clear" onClick={onClear} aria-label="Clear">
        <X size={15} />
      </button>
      <span className="selbar__divider" />
      <Button variant="accent" size="sm" onClick={onArchive}>
        Archive
      </Button>
    </div>
  )
}

export function HealthGate({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="scrim scrim--gate">
      <div className="gate">
        <div className="gate__head">
          <span className="gate__chip">
            <AlertTriangle size={24} />
          </span>
          <h3 className="gate__title">Backend API not reachable</h3>
        </div>
        <p className="gate__body">
          The console can&rsquo;t reach the Funky API at <code>localhost:3000/healthz</code>. Start
          the stack, then retry:
        </p>
        <pre className="gate__pre">
          {`cp .env.example .env        # set FUNKY_AUTH_TOKEN to any long random string
docker compose up --build`}
        </pre>
        <div className="gate__foot">
          <Button variant="primary" onClick={onRetry}>
            Retry connection
          </Button>
        </div>
      </div>
    </div>
  )
}
