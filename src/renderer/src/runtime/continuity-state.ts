import type { ContinuityStateSnapshot } from '../../../shared/continuity-state-types'
import { getCrewCodeRuntime } from './crewcode-client'

const KEYS = [
  'crewcode:sessionsByTab',
  'crewcode:activeSessionByTab',
  'crewcode:workspaceTabs:v1',
  'crewcode:activeWorkspaceId',
] as const

let syncInstalled = false
let lastValues: Record<string, string> = {}

function localValues(): Record<string, string> {
  const values: Record<string, string> = {}
  for (const key of KEYS) {
    const value = localStorage.getItem(key)
    if (value !== null) values[key] = value
  }
  return values
}

function changedValues(next: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(next).filter(([key, value]) => lastValues[key] !== value))
}

async function pushChanged(): Promise<void> {
  const runtime = getCrewCodeRuntime()
  if (runtime.kind === 'electron') return
  const next = localValues()
  const patch = changedValues(next)
  if (Object.keys(patch).length === 0) return
  await runtime.client.continuityStateUpdate(patch)
  lastValues = next
}

function installSync(): void {
  if (syncInstalled) return
  syncInstalled = true
  const timer = window.setInterval(() => { void pushChanged().catch(() => undefined) }, 2_000)
  const flush = () => { void pushChanged().catch(() => undefined) }
  window.addEventListener('pagehide', flush)
  window.addEventListener('beforeunload', flush)
  // The timer intentionally remains for this immutable application runtime.
  void timer
}

/** Hydrate navigation state before React hooks read localStorage, then mirror later edits. */
export async function hydrateContinuityState(): Promise<void> {
  const runtime = getCrewCodeRuntime()
  if (runtime.kind === 'electron') return
  const api = runtime.client
  let snapshot: ContinuityStateSnapshot
  try { snapshot = await api.continuityStateGet() } catch { return }
  const local = localValues()
  if (snapshot.revision === 0 && Object.keys(local).length > 0) {
    try { snapshot = await api.continuityStateUpdate(local) } catch { /* next periodic attempt retries */ }
  } else {
    for (const [key, value] of Object.entries(snapshot.values)) {
      if ((KEYS as readonly string[]).includes(key)) localStorage.setItem(key, value)
    }
  }
  lastValues = localValues()
  installSync()
}
