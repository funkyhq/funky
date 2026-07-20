import { useEffect, useState } from 'react'
import { MessageSquare } from 'lucide-react'
import { sessions as sessApi } from '../lib/api'
import type { Agent, Environment, Session } from '../lib/types'
import { errMsg, initials, relativeTime, shortId } from '../lib/format'
import { Avatar, Badge, Button, Checkbox, Modal, Select, Textarea } from '../ui/ui'
import { ArchiveItem, EmptyState, Kebab, PageHeader, SelectionBar } from './parts'
import { useSelection } from './data'

export function Sessions({
  sessions,
  agents,
  environments,
  reload,
  onOpen,
  notify,
}: {
  sessions: Session[]
  agents: Agent[]
  environments: Environment[]
  reload: () => Promise<void>
  onOpen: (id: string) => void
  notify: (msg: string) => void
}) {
  const sel = useSelection()
  const [open, setOpen] = useState(false)

  const agentName = (id: string) => agents.find((a) => a.id === id)?.name ?? `agent ${shortId(id)}`
  const envName = (id: string) => environments.find((e) => e.id === id)?.name ?? shortId(id)

  async function archive(ids: string[]) {
    try {
      await Promise.all(ids.map((id) => sessApi.archive(id)))
      sel.clear()
      await reload()
    } catch (e) {
      notify(errMsg(e))
    }
  }

  return (
    <div className="scroll">
      <div className="content">
        <PageHeader
          title="Sessions"
          subtitle="Live chats — an agent running in an environment, backed by a durable event log."
          action={
            <Button variant="primary" onClick={() => setOpen(true)}>
              Create session
            </Button>
          }
        />

        {sessions.length === 0 ? (
          <EmptyState
            icon={<MessageSquare size={30} />}
            title="No sessions yet"
            subtitle="Start one from the Quick Start, or create it directly."
          />
        ) : (
          <div className="list">
            {sessions.map((s) => (
              <div className="row" key={s.id} data-selected={sel.ids.has(s.id) || undefined}>
                <Checkbox checked={sel.ids.has(s.id)} onChange={() => sel.toggle(s.id)} />
                <div className="row__body" data-clickable onClick={() => onOpen(s.id)} style={{ cursor: 'pointer' }}>
                  <Avatar initials={initials(agentName(s.agent.id))} />
                  <div style={{ minWidth: 0, width: 230 }}>
                    <div className="row__name row__name--mono">{s.title ?? shortId(s.id)}</div>
                    <div className="row__sub row__sub--body">{agentName(s.agent.id)}</div>
                  </div>
                  <div className="row__col">
                    <div className="row__col-label">Environment</div>
                    <div className="row__col-val">{envName(s.environment_id)}</div>
                  </div>
                  <div className="row__col">
                    <div className="row__col-label">Created</div>
                    <div className="row__col-val row__col-val--body">{relativeTime(s.created_at)}</div>
                  </div>
                  <StatusBadge session={s} />
                </div>
                <Kebab>{(close) => <ArchiveItem onClick={() => { close(); void archive([s.id]) }} />}</Kebab>
              </div>
            ))}
          </div>
        )}

        <SelectionBar
          count={sel.ids.size}
          onClear={sel.clear}
          onArchive={() => void archive([...sel.ids])}
        />
      </div>

      <CreateSessionModal
        open={open}
        onClose={() => setOpen(false)}
        agents={agents}
        environments={environments}
        onCreated={async (id) => {
          setOpen(false)
          await reload()
          onOpen(id)
        }}
        notify={notify}
      />
    </div>
  )
}

function StatusBadge({ session }: { session: Session }) {
  if (session.status === 'failed') return <Badge tone="red" dot>failed</Badge>
  if (session.status === 'provisioning') return <Badge tone="neutral" dot>provisioning</Badge>
  return <Badge tone="green" dot>ready</Badge>
}

function CreateSessionModal({
  open,
  onClose,
  agents,
  environments,
  onCreated,
  notify,
}: {
  open: boolean
  onClose: () => void
  agents: Agent[]
  environments: Environment[]
  onCreated: (id: string) => Promise<void>
  notify: (msg: string) => void
}) {
  const [agentId, setAgentId] = useState('')
  const [envId, setEnvId] = useState('')
  const [msg, setMsg] = useState('')
  const [saving, setSaving] = useState(false)

  // Default the selects once data is available / the modal opens.
  useEffect(() => {
    if (open) {
      setAgentId((v) => v || agents[0]?.id || '')
      setEnvId((v) => v || environments[0]?.id || '')
    }
  }, [open, agents, environments])

  const ready = agents.length > 0 && environments.length > 0

  async function create() {
    if (!agentId || !envId) {
      notify('Pick an agent and an environment.')
      return
    }
    setSaving(true)
    try {
      const session = await sessApi.create({ agent: agentId, environment_id: envId })
      const text = msg.trim()
      if (text) {
        const ready = await sessApi.waitReady(session.id)
        if (ready.status === 'failed') throw new Error('The session failed to provision its sandbox.')
        await sessApi.sendMessage(session.id, text)
      }
      setMsg('')
      await onCreated(session.id)
    } catch (e) {
      notify(errMsg(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={420}
      title="Create session"
      footer={
        <>
          <Button variant="secondary" fullWidth onClick={onClose}>
            Cancel
          </Button>
          <Button variant="accent" fullWidth disabled={saving || !ready} onClick={() => void create()}>
            {saving ? 'Creating…' : 'Create session'}
          </Button>
        </>
      }
    >
      <p className="modal__intro">Pick the agent and environment for this session.</p>
      {!ready ? (
        <p className="qs-error">
          You need at least one agent and one environment first.
        </p>
      ) : null}
      <div className="modal__form">
        <Select
          label="Agent"
          value={agentId}
          options={agents.map((a) => ({
            value: a.id,
            label: a.runtime?.type === 'claude-code' ? `${a.name} · Claude Code` : a.name,
          }))}
          onChange={setAgentId}
        />
        <Select
          label="Environment"
          value={envId}
          options={environments.map((e) => ({ value: e.id, label: e.name }))}
          onChange={setEnvId}
        />
        <Textarea
          label="First message (optional)"
          rows={3}
          placeholder="Ask your agent something…"
          value={msg}
          onChange={setMsg}
        />
      </div>
    </Modal>
  )
}
