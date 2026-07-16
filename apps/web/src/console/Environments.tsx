import { useState } from 'react'
import { Box, Layers } from 'lucide-react'
import { environments as envsApi } from '../lib/api'
import type { Environment } from '../lib/types'
import { errMsg, slug } from '../lib/format'
import { Avatar, Badge, Button, Checkbox, Input, Modal, Textarea } from '../ui/ui'
import { ArchiveItem, EmptyState, Kebab, PageHeader, SelectionBar } from './parts'
import { useSelection } from './data'

export function Environments({
  environments,
  reload,
  notify,
}: {
  environments: Environment[]
  reload: () => Promise<void>
  notify: (msg: string) => void
}) {
  const sel = useSelection()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [desc, setDesc] = useState('')
  const [saving, setSaving] = useState(false)

  async function create() {
    if (!name.trim()) {
      notify('Name is required.')
      return
    }
    setSaving(true)
    try {
      await envsApi.create({ name: name.trim(), description: desc.trim() || null })
      setOpen(false)
      setName('')
      setDesc('')
      await reload()
    } catch (e) {
      notify(errMsg(e))
    } finally {
      setSaving(false)
    }
  }

  async function archive(ids: string[]) {
    try {
      await Promise.all(ids.map((id) => envsApi.archive(id)))
      sel.clear()
      await reload()
    } catch (e) {
      notify(errMsg(e))
    }
  }

  return (
    <div className="content">
      <PageHeader
        title="Environments"
        subtitle="Sandbox runtimes where each agent's commands run."
        action={
          <Button variant="primary" onClick={() => setOpen(true)}>
            New environment
          </Button>
        }
      />

      {environments.length === 0 ? (
        <EmptyState
          icon={<Layers size={30} />}
          title="No environments yet"
          subtitle="Create an environment to give your agents a place to run."
        />
      ) : (
        <div className="list">
          {environments.map((e) => (
            <div className="row" key={e.id} data-selected={sel.ids.has(e.id) || undefined}>
              <Checkbox checked={sel.ids.has(e.id)} onChange={() => sel.toggle(e.id)} />
              <div className="row__body">
                <Avatar icon={<Box size={22} />} size={44} />
                <div style={{ minWidth: 0, width: 220 }}>
                  <div className="row__name" style={{ fontSize: 16, fontWeight: 800 }}>
                    {e.name}
                  </div>
                  <div className="row__sub">{slug(e.name)}</div>
                </div>
                <div className="row__excerpt">{e.description ?? ''}</div>
                <Badge tone="green" dot>
                  Active
                </Badge>
              </div>
              <Kebab>{(close) => <ArchiveItem onClick={() => { close(); void archive([e.id]) }} />}</Kebab>
            </div>
          ))}
        </div>
      )}

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="New environment"
        footer={
          <>
            <Button variant="secondary" fullWidth onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" fullWidth disabled={saving} onClick={() => void create()}>
              {saving ? 'Creating…' : 'Create environment'}
            </Button>
          </>
        }
      >
        <div className="modal__form">
          <Input label="Name" placeholder="e.g. python-ml" value={name} onChange={setName} />
          <Textarea
            label="Description"
            rows={3}
            placeholder="What this environment provides…"
            value={desc}
            onChange={setDesc}
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
