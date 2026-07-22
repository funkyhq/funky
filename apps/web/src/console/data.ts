import { useCallback, useEffect, useRef, useState } from 'react'
import { agents as agentsApi, checkHealth, environments as envsApi, sessions as sessApi } from '../lib/api'
import type { Agent, Environment, Session } from '../lib/types'

/** Multi-select state for a list of rows keyed by id. */
export function useSelection() {
  const [ids, setIds] = useState<Set<string>>(new Set())
  const toggle = useCallback((id: string) => {
    setIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])
  const clear = useCallback(() => setIds(new Set()), [])
  return { ids, toggle, clear }
}

/** Calls `onOutside` when a pointer/keydown lands outside the returned ref's element. */
export function useClickOutside<T extends HTMLElement>(active: boolean, onOutside: () => void) {
  const ref = useRef<T>(null)
  useEffect(() => {
    if (!active) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onOutside()
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onOutside()
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [active, onOutside])
  return ref
}

export type HealthStatus = 'checking' | 'ok' | 'down'

/** Health gate: probe /health on mount, auto-retry while down, expose a manual retry. */
export function useHealth() {
  const [status, setStatus] = useState<HealthStatus>('checking')
  const busy = useRef(false)

  const probe = useCallback(async () => {
    if (busy.current) return
    busy.current = true
    const ok = await checkHealth()
    busy.current = false
    setStatus(ok ? 'ok' : 'down')
  }, [])

  useEffect(() => {
    void probe()
  }, [probe])

  // While down, poll so the console recovers on its own once the backend boots.
  useEffect(() => {
    if (status !== 'down') return
    const t = setInterval(() => void probe(), 4000)
    return () => clearInterval(t)
  }, [status, probe])

  const retry = useCallback(() => {
    setStatus('checking')
    void probe()
  }, [probe])

  return { status, retry }
}

/** Loads and refreshes the three entity lists (active only). App drives when to load. */
export function useConsoleData() {
  const [agents, setAgents] = useState<Agent[]>([])
  const [environments, setEnvironments] = useState<Environment[]>([])
  const [sessions, setSessions] = useState<Session[]>([])

  const reloadAgents = useCallback(async () => {
    const page = await agentsApi.list({ limit: 100 })
    setAgents(page.data)
  }, [])
  const reloadEnvironments = useCallback(async () => {
    const page = await envsApi.list({ limit: 100 })
    setEnvironments(page.data)
  }, [])
  const reloadSessions = useCallback(async () => {
    const page = await sessApi.list({ limit: 100 })
    setSessions(page.data)
  }, [])

  const reloadAll = useCallback(async () => {
    await Promise.all([reloadAgents(), reloadEnvironments(), reloadSessions()])
  }, [reloadAgents, reloadEnvironments, reloadSessions])

  return {
    agents,
    environments,
    sessions,
    reloadAgents,
    reloadEnvironments,
    reloadSessions,
    reloadAll,
  }
}
