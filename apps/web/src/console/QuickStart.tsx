import { useState } from 'react'
import { Check } from 'lucide-react'
import { agents as agentsApi, environments as envsApi, sessions as sessApi } from '../lib/api'
import { modelConfigFor } from '../lib/models'
import { networkPolicy, networkSummary, type NetworkMode } from '../lib/network'
import { errMsg, initials } from '../lib/format'
import { Avatar, Badge, Button, CodeBlock, Input, Textarea } from '../ui/ui'
import { ModelField, NetworkFields, RuntimeField } from './parts'
import { buildCurl } from './curl'

const DEFAULT_PROMPT = 'You are an autonomous research and coding agent.'

const STEP_LABELS = ['Create agent', 'Configure environment', 'Start session', 'First message']

export function QuickStart({ onLaunch }: { onLaunch: (sessionId: string) => Promise<void> }) {
  const [step, setStep] = useState(1)
  const [agentName, setAgentName] = useState('Funky Assistant')
  const [model, setModel] = useState('Sonnet 5')
  const [runtime, setRuntime] = useState<'native' | 'claude-code'>('native')
  const [systemPrompt, setSystemPrompt] = useState(DEFAULT_PROMPT)
  const [envName, setEnvName] = useState('basic')
  const [envDesc, setEnvDesc] = useState('default dev box')
  const [networkMode, setNetworkMode] = useState<NetworkMode>('unrestricted')
  const [allowedHosts, setAllowedHosts] = useState('')
  const [message, setMessage] = useState('What is the top 3 trending project on Github?')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const next = () => setStep((s) => Math.min(4, s + 1))
  const back = () => setStep((s) => Math.max(1, s - 1))

  function guardStep1() {
    if (!agentName.trim() || !systemPrompt.trim()) {
      setError('Give your agent a name and a system prompt.')
      return
    }
    setError('')
    next()
  }
  function guardStep2() {
    if (!envName.trim()) {
      setError('Give your environment a name.')
      return
    }
    setError('')
    next()
  }

  // Final submit: create agent → environment → session → send the first message, then open
  // the session's chat. This is exactly what the curl panel on the right spells out.
  async function launch() {
    const text = message.trim()
    if (!text) {
      setError('Type a first message for your agent.')
      return
    }
    setError('')
    setBusy(true)
    try {
      const agent = await agentsApi.create({
        name: agentName.trim(),
        system_prompt: systemPrompt.trim(),
        model: modelConfigFor(model),
        runtime: { type: runtime },
      })
      const env = await envsApi.create({
        name: envName.trim(),
        description: envDesc.trim() || null,
        network: networkPolicy(networkMode, allowedHosts),
      })
      const session = await sessApi.create({ agent: agent.id, environment_id: env.id })
      const ready = await sessApi.waitReady(session.id)
      if (ready.status === 'failed') throw new Error('The session failed to provision its sandbox.')
      await sessApi.sendMessage(session.id, text)
      await onLaunch(session.id)
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  const network = networkPolicy(networkMode, allowedHosts)
  const curl = buildCurl({ step, agentName, model, runtime, systemPrompt, envName, envDesc, network, message })

  return (
    <div className="content">
      <h1 className="page-title">Quick Start</h1>
      <p className="page-sub">From nothing to a live agent chat in four steps.</p>

      <Stepper step={step} />

      <div className="qs-grid">
        <div className="panel">
          {error ? <div className="qs-error" style={{ marginBottom: 16 }}>{error}</div> : null}

          {step === 1 ? (
            <div className="qs-form">
              <div>
                <h2>Create your agent</h2>
                <p className="qs-form__sub">Who it is and which model powers it.</p>
              </div>
              <Input label="Agent name" placeholder="Name your agent" value={agentName} onChange={setAgentName} />
              <ModelField value={model} onChange={setModel} />
              <RuntimeField value={runtime} onChange={setRuntime} />
              <Textarea label="System prompt" rows={5} value={systemPrompt} onChange={setSystemPrompt} />
              <div className="qs-foot qs-foot--end">
                <Button variant="accent" size="lg" onClick={guardStep1}>
                  Continue
                </Button>
              </div>
            </div>
          ) : null}

          {step === 2 ? (
            <div className="qs-form">
              <div>
                <h2>Configure the environment</h2>
                <p className="qs-form__sub">Where the agent&rsquo;s commands run.</p>
              </div>
              <Input label="Name" placeholder="basic" value={envName} onChange={setEnvName} />
              <Textarea label="Description" rows={3} placeholder="default dev box" value={envDesc} onChange={setEnvDesc} />
              <NetworkFields
                mode={networkMode}
                allowedHosts={allowedHosts}
                onModeChange={setNetworkMode}
                onAllowedHostsChange={setAllowedHosts}
              />
              <div className="qs-foot qs-foot--split">
                <Button variant="secondary" size="lg" onClick={back}>
                  Back
                </Button>
                <Button variant="accent" size="lg" onClick={guardStep2}>
                  Continue
                </Button>
              </div>
            </div>
          ) : null}

          {step === 3 ? (
            <div className="qs-form">
              <div>
                <h2>Start the session</h2>
                <p className="qs-form__sub">Review, then spin it up.</p>
              </div>
              <div className="review">
                <ReviewRow label="Agent" value={agentName} strong />
                <ReviewRow label="Model" value={model} mono />
                <ReviewRow label="Runtime" value={runtime === 'claude-code' ? 'Claude Code' : 'Native'} />
                <ReviewRow label="Environment" value={envName} mono />
                <ReviewRow label="Network" value={networkSummary(network)} />
                <ReviewRow label="System prompt" value={systemPrompt} />
              </div>
              <div className="qs-foot qs-foot--split">
                <Button variant="secondary" size="lg" onClick={back}>
                  Back
                </Button>
                <Button variant="accent" size="lg" onClick={next}>
                  Start session
                </Button>
              </div>
            </div>
          ) : null}

          {step === 4 ? (
            <div className="qs-form">
              <div>
                <h2>Send the first message</h2>
                <p className="qs-form__sub">This creates everything and opens the chat.</p>
              </div>
              <div className="ready-card">
                <Avatar initials={initials(agentName)} size={42} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="ready-card__name">{agentName || 'Agent'}</div>
                  <div className="ready-card__sub">{model} · {envName || 'basic'}</div>
                </div>
                <Badge tone="green" dot>
                  live
                </Badge>
              </div>
              <Textarea
                label="Your message"
                rows={3}
                placeholder="Ask your agent something…"
                value={message}
                onChange={setMessage}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    void launch()
                  }
                }}
              />
              <div className="qs-foot qs-foot--split">
                <Button variant="secondary" size="lg" onClick={back} disabled={busy}>
                  Back
                </Button>
                <Button variant="accent" size="lg" disabled={busy} onClick={() => void launch()}>
                  {busy ? 'Starting…' : 'Send message →'}
                </Button>
              </div>
            </div>
          ) : null}
        </div>

        <div className="qs-code">
          <div className="qs-code__eyebrow">Equivalent API call</div>
          <CodeBlock code={curl} filename="quickstart.sh" />
        </div>
      </div>
    </div>
  )
}

function Stepper({ step }: { step: number }) {
  return (
    <div className="stepper">
      {STEP_LABELS.map((label, i) => {
        const n = i + 1
        const state = step > n ? 'done' : step === n ? 'current' : 'upcoming'
        return (
          <div className="step" key={label}>
            <span className="step__dot" data-state={state}>
              {state === 'done' ? <Check size={16} strokeWidth={3} /> : n}
            </span>
            <span className="step__label" data-active={state !== 'upcoming' || undefined}>
              {label}
            </span>
            {n < STEP_LABELS.length ? <span className="step__line" /> : null}
          </div>
        )
      })}
    </div>
  )
}

function ReviewRow({
  label,
  value,
  strong,
  mono,
}: {
  label: string
  value: string
  strong?: boolean
  mono?: boolean
}) {
  const cls = ['review__val', strong ? 'review__val--strong' : '', mono ? 'review__val--mono' : '']
    .filter(Boolean)
    .join(' ')
  return (
    <div className="review__row">
      <span className="review__label">{label}</span>
      <span className={cls}>{value}</span>
    </div>
  )
}
