import { useState } from 'react'
import { Cpu } from 'lucide-react'
import { agents as agentsApi } from '../lib/api'
import type { Agent } from '../lib/types'
import { DEFAULT_MODEL_LABEL, modelConfigFor, modelLabel } from '../lib/models'
import { errMsg, initials } from '../lib/format'
import { Avatar, Badge, Button, Checkbox, Modal, Textarea, Input } from '../ui/ui'
import { ArchiveItem, EmptyState, Kebab, ModelField, PageHeader, RuntimeField, SelectionBar } from './parts'
import { useSelection } from './data'

export function Agents({
  agents,
  reload,
  notify,
}: {
  agents: Agent[]
  reload: () => Promise<void>
  notify: (msg: string) => void
}) {
  const sel = useSelection()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [model, setModel] = useState(DEFAULT_MODEL_LABEL)
  const [runtime, setRuntime] = useState<'native' | 'claude-code'>('native')
  const [prompt, setPrompt] = useState('')
  const [saving, setSaving] = useState(false)

  async function create() {
    if (!name.trim() || !prompt.trim()) {
      notify('Name and system prompt are required.')
      return
    }
    setSaving(true)
    try {
      await agentsApi.create({
        name: name.trim(),
        system_prompt: prompt.trim(),
        model: modelConfigFor(model),
        runtime: { type: runtime },
      })
      setOpen(false)
      setName('')
      setPrompt('')
      setModel(DEFAULT_MODEL_LABEL)
      setRuntime('native')
      await reload()
    } catch (e) {
      notify(errMsg(e))
    } finally {
      setSaving(false)
    }
  }

  async function archive(ids: string[]) {
    try {
      await Promise.all(ids.map((id) => agentsApi.archive(id)))
      sel.clear()
      await reload()
    } catch (e) {
      notify(errMsg(e))
    }
  }

  return (
    <div className="content">
      <PageHeader
        title="Agents"
        subtitle="Reusable agent definitions — a system prompt and a model."
        action={
          <Button variant="primary" onClick={() => setOpen(true)}>
            New agent
          </Button>
        }
      />

      {agents.length === 0 ? (
        <EmptyState
          icon={<Cpu size={30} />}
          title="No agents yet"
          subtitle="Create your first agent, or run through the Quick Start."
        />
      ) : (
        <div className="list">
          {agents.map((a) => (
            <div className="row" key={a.id} data-selected={sel.ids.has(a.id) || undefined}>
              <Checkbox checked={sel.ids.has(a.id)} onChange={() => sel.toggle(a.id)} />
              <div className="row__body">
                <Avatar initials={initials(a.name)} />
                <div style={{ minWidth: 0, width: 190 }}>
                  <div className="row__name">{a.name}</div>
                  <div className="row__sub">{modelLabel(a.model)}</div>
                </div>
                <div className="row__excerpt">{a.system_prompt}</div>
                {a.runtime?.type === 'claude-code' ? <Badge tone="neutral">Claude Code</Badge> : null}
                <Badge tone="green" dot>
                  Ready
                </Badge>
              </div>
              <Kebab>{(close) => <ArchiveItem onClick={() => { close(); void archive([a.id]) }} />}</Kebab>
            </div>
          ))}
        </div>
      )}

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="New agent"
        footer={
          <>
            <Button variant="secondary" fullWidth onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" fullWidth disabled={saving} onClick={() => void create()}>
              {saving ? 'Creating…' : 'Create agent'}
            </Button>
          </>
        }
      >
        <div className="modal__form">
          <Input label="Agent name" placeholder="Name your agent" value={name} onChange={setName} />
          <ModelField value={model} onChange={setModel} />
          <RuntimeField value={runtime} onChange={setRuntime} />
          <Textarea
            label="System prompt"
            rows={4}
            placeholder="Describe how this agent should behave…"
            value={prompt}
            onChange={setPrompt}
          />
        </div>
      </Modal>

      <SelectionBar
        count={sel.ids.size}
        onClear={sel.clear}
        onArchive={() => void archive([...sel.ids])}
      />
    </div>
  )
}
