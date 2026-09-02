import {
  DESKTOP_CATALOGUE_AUTHORITY_KEY,
  DESKTOP_CATALOGUE_AUTHORITY_VALUE,
  type ContinuityStateSnapshot,
  type ContinuityTranscriptEntry,
} from '../../../shared/continuity-state-types'
import { getCrewCodeRuntime } from './crewcode-client'
import { chatTabCreatedAt } from '../hooks/chat-session-order'
import { chatSessionOwnerWorkspaceId } from '../hooks/chat-session-tab-owner'

const KEYS = [
  'crewcode:sessionsByTab',
  'crewcode:activeSessionByTab',
  'crewcode:workspaceTabs:v1',
  'crewcode:activeWorkspaceId',
  'crewcode:sessionCompletedAt:v1',
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

function parseRecord(value: string | undefined): Record<string, unknown> {
  if (!value) return {}
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch { return {} }
}

interface CatalogueRow {
  id?: unknown
  label?: unknown
  createdAt?: unknown
  lastUsedAt?: unknown
  continuityRecovered?: unknown
}

const RECOVERED_LABEL = /^Recovered chat · \d{4}-\d{2}-\d{2}$/

function hasRecoveredLabel(row: CatalogueRow): boolean {
  return typeof row.label === 'string' && RECOVERED_LABEL.test(row.label)
}

function isRecoveredRow(row: unknown): boolean {
  if (!row || typeof row !== 'object') return false
  const candidate = row as CatalogueRow
  if (candidate.continuityRecovered === true) return true
  // Migration for the first recovery build, which persisted synthetic rows
  // before explicit provenance existed. Renderer-created clocks are integers;
  // transcript filesystem mtimes may be fractional.
  if (hasRecoveredLabel(candidate)) return true
  return [candidate.createdAt, candidate.lastUsedAt].some(value => typeof value === 'number' && Number.isFinite(value) && !Number.isInteger(value))
}

function isSyntheticCatalogueRow(row: unknown): boolean {
  if (!row || typeof row !== 'object') return false
  const candidate = row as CatalogueRow
  return candidate.continuityRecovered === true || hasRecoveredLabel(candidate)
}

function recoveredSessionLabel(transcript: ContinuityTranscriptEntry | undefined, workspaceName: string, canonical: boolean, at: number): string {
  const fromHint = transcript?.titleHint?.trim()
  if (fromHint) return fromHint.slice(0, 80)
  return canonical ? workspaceName : `Chat · ${new Date(at).toISOString().slice(0, 10)}`
}

function mergeRowsById(remote: unknown, local: unknown): unknown[] {
  const next = Array.isArray(remote) ? remote.filter(row => row && typeof row === 'object') : []
  const seen = new Set(next.flatMap(row => typeof (row as { id?: unknown }).id === 'string' ? [(row as { id: string }).id] : []))
  for (const row of Array.isArray(local) ? local : []) {
    if (!row || typeof row !== 'object') continue
    const id = (row as { id?: unknown }).id
    if (typeof id !== 'string' || !id || seen.has(id)) continue
    seen.add(id)
    next.push(row)
  }
  return next
}

function mergeReplacingRecoveredRows(remote: unknown, local: unknown): unknown[] {
  const remoteRows = Array.isArray(remote) ? remote.filter(row => row && typeof row === 'object') : []
  const next: unknown[] = []
  const seen = new Set<string>()
  for (const localRow of Array.isArray(local) ? local : []) {
    if (!localRow || typeof localRow !== 'object') continue
    const id = (localRow as CatalogueRow).id
    if (typeof id !== 'string' || !id || seen.has(id)) continue
    next.push(localRow)
    seen.add(id)
  }
  // Preserve genuine sessions created from web while desktop was detached,
  // but drop transcript-derived rows absent from the real desktop catalogue.
  for (const remoteRow of remoteRows) {
    const id = (remoteRow as CatalogueRow).id
    if (typeof id !== 'string' || !id || seen.has(id) || isRecoveredRow(remoteRow)) continue
    next.push(remoteRow)
    seen.add(id)
  }
  return next
}

function catalogueHasRecoveredRows(sessions: Record<string, unknown>): boolean {
  return Object.values(sessions).some(rows => Array.isArray(rows) && rows.some(isRecoveredRow))
}

function mergeSessionsValue(remote: string | undefined, local: string | undefined, preferDesktopRows: boolean): string | undefined {
  if (!remote) return local
  if (!local) return remote
  const remoteMap = parseRecord(remote)
  const localMap = parseRecord(local)
  const merged: Record<string, unknown[]> = {}
  const tabIds = preferDesktopRows
    ? new Set([...Object.keys(localMap), ...Object.keys(remoteMap)])
    : new Set([...Object.keys(remoteMap), ...Object.keys(localMap)])
  for (const tabId of tabIds) {
    const rows = preferDesktopRows
      ? mergeReplacingRecoveredRows(remoteMap[tabId], localMap[tabId])
      : mergeRowsById(remoteMap[tabId], localMap[tabId])
    if (rows.length > 0) merged[tabId] = rows
  }
  return JSON.stringify(merged)
}

function mergeWorkspaceTabsValue(remote: string | undefined, local: string | undefined, preferDesktopRows: boolean): string | undefined {
  if (!remote) return local
  if (!local) return remote
  const remoteValue = parseRecord(remote)
  const localValue = parseRecord(local)
  const remoteTabs = remoteValue.wsTabs && typeof remoteValue.wsTabs === 'object' ? remoteValue.wsTabs as Record<string, unknown> : {}
  const localTabs = localValue.wsTabs && typeof localValue.wsTabs === 'object' ? localValue.wsTabs as Record<string, unknown> : {}
  const wsTabs: Record<string, unknown[]> = {}
  const workspaceIds = preferDesktopRows
    ? new Set([...Object.keys(localTabs), ...Object.keys(remoteTabs)])
    : new Set([...Object.keys(remoteTabs), ...Object.keys(localTabs)])
  for (const workspaceId of workspaceIds) {
    wsTabs[workspaceId] = preferDesktopRows
      ? mergeReplacingRecoveredRows(remoteTabs[workspaceId], localTabs[workspaceId])
      : mergeRowsById(remoteTabs[workspaceId], localTabs[workspaceId])
  }
  const remoteActive = remoteValue.activeByWs && typeof remoteValue.activeByWs === 'object' ? remoteValue.activeByWs as Record<string, unknown> : {}
  const localActive = localValue.activeByWs && typeof localValue.activeByWs === 'object' ? localValue.activeByWs as Record<string, unknown> : {}
  const remoteSplits = remoteValue.splitMap && typeof remoteValue.splitMap === 'object' ? remoteValue.splitMap as Record<string, unknown> : {}
  const localSplits = localValue.splitMap && typeof localValue.splitMap === 'object' ? localValue.splitMap as Record<string, unknown> : {}
  const splitMap: Record<string, unknown[]> = {}
  for (const workspaceId of new Set([...Object.keys(remoteSplits), ...Object.keys(localSplits)])) {
    splitMap[workspaceId] = mergeRowsById(remoteSplits[workspaceId], localSplits[workspaceId])
  }
  return JSON.stringify({ wsTabs, activeByWs: { ...localActive, ...remoteActive }, splitMap })
}

/** Until desktop catalogue authority exists, attached Electron reseeds exact
 * desktop names and order. After that, Brain wins identities it already owns. */
export function mergeAttachedDesktopCatalogue(remote: Record<string, string>, local: Record<string, string>): Record<string, string> {
  const merged = { ...remote }
  const remoteSessions = parseRecord(remote['crewcode:sessionsByTab'])
  const localSessions = parseRecord(local['crewcode:sessionsByTab'])
  const repairsRecoveredCatalogue = remote[DESKTOP_CATALOGUE_AUTHORITY_KEY] !== DESKTOP_CATALOGUE_AUTHORITY_VALUE
    || catalogueHasRecoveredRows(remoteSessions)
  const sessions = mergeSessionsValue(remote['crewcode:sessionsByTab'], local['crewcode:sessionsByTab'], repairsRecoveredCatalogue)
  if (sessions) merged['crewcode:sessionsByTab'] = sessions
  const tabs = mergeWorkspaceTabsValue(remote['crewcode:workspaceTabs:v1'], local['crewcode:workspaceTabs:v1'], repairsRecoveredCatalogue)
  if (tabs) merged['crewcode:workspaceTabs:v1'] = tabs
  const remoteActive = parseRecord(remote['crewcode:activeSessionByTab'])
  const localActive = parseRecord(local['crewcode:activeSessionByTab'])
  if (Object.keys(remoteActive).length || Object.keys(localActive).length) {
    if (!repairsRecoveredCatalogue) {
      merged['crewcode:activeSessionByTab'] = JSON.stringify({ ...localActive, ...remoteActive })
    } else {
      const mergedSessions = parseRecord(sessions)
      const active: Record<string, string> = {}
      for (const [tabId, rows] of Object.entries(mergedSessions)) {
        const ids = new Set((Array.isArray(rows) ? rows : []).flatMap(row => {
          const id = row && typeof row === 'object' ? (row as CatalogueRow).id : undefined
          return typeof id === 'string' ? [id] : []
        }))
        const localId = localActive[tabId]
        const remoteId = remoteActive[tabId]
        if (typeof localId === 'string' && ids.has(localId)) active[tabId] = localId
        else if (!(tabId in localSessions) && typeof remoteId === 'string' && ids.has(remoteId)) active[tabId] = remoteId
      }
      merged['crewcode:activeSessionByTab'] = JSON.stringify(active)
    }
  }
  if (!merged['crewcode:activeWorkspaceId'] && local['crewcode:activeWorkspaceId']) {
    merged['crewcode:activeWorkspaceId'] = local['crewcode:activeWorkspaceId']
  }
  const completed = mergeCompletedAtValue(remote['crewcode:sessionCompletedAt:v1'], local['crewcode:sessionCompletedAt:v1'])
  if (completed) merged['crewcode:sessionCompletedAt:v1'] = completed
  return merged
}

function mergeCompletedAtValue(remote: string | undefined, local: string | undefined): string | undefined {
  if (!remote) return local
  if (!local) return remote
  const remoteMap = parseRecord(remote)
  const localMap = parseRecord(local)
  const merged: Record<string, number> = {}
  for (const scope of new Set([...Object.keys(localMap), ...Object.keys(remoteMap)])) {
    const times = [localMap[scope], remoteMap[scope]].filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
    if (times.length > 0) merged[scope] = Math.max(...times)
  }
  return JSON.stringify(merged)
}

interface RecoveryWorkspace { id: string; name: string }

function sessionOrdinal(scopeId: string, tabId: string): number {
  if (scopeId === tabId) return 1
  const match = scopeId.match(/::s(\d+)$/)
  const ordinal = match ? Number(match[1]) : Number.NaN
  return Number.isSafeInteger(ordinal) && ordinal > 0 ? ordinal : Number.MAX_SAFE_INTEGER
}

function compareDesktopSessionOrder(left: unknown, right: unknown, tabId: string): number {
  const leftRow = left && typeof left === 'object' ? left as CatalogueRow : {}
  const rightRow = right && typeof right === 'object' ? right as CatalogueRow : {}
  const leftId = typeof leftRow.id === 'string' ? leftRow.id : ''
  const rightId = typeof rightRow.id === 'string' ? rightRow.id : ''
  const byOrdinal = sessionOrdinal(leftId, tabId) - sessionOrdinal(rightId, tabId)
  if (byOrdinal !== 0) return byOrdinal
  const leftAt = typeof leftRow.createdAt === 'number' && Number.isFinite(leftRow.createdAt) ? leftRow.createdAt : 0
  const rightAt = typeof rightRow.createdAt === 'number' && Number.isFinite(rightRow.createdAt) ? rightRow.createdAt : 0
  return leftAt - rightAt
}

function tabOldestClock(rows: unknown): number {
  let oldest = Number.POSITIVE_INFINITY
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== 'object') continue
    const candidate = row as CatalogueRow
    for (const value of [candidate.createdAt, candidate.lastUsedAt]) {
      if (typeof value === 'number' && Number.isFinite(value) && value > 0 && value < oldest) oldest = value
    }
  }
  return Number.isFinite(oldest) ? oldest : 0
}

/** Desktop stores oldest tabs first so the drawer reverse shows newest on top. */
function orderSessionsMapOldestFirst(sessions: Record<string, unknown>): Record<string, unknown[]> {
  const tabIds = Object.keys(sessions).sort((left, right) => {
    const byTab = chatTabCreatedAt(left) - chatTabCreatedAt(right)
    if (byTab !== 0) return byTab
    const byClock = tabOldestClock(sessions[left]) - tabOldestClock(sessions[right])
    return byClock !== 0 ? byClock : left.localeCompare(right)
  })
  const ordered: Record<string, unknown[]> = {}
  for (const tabId of tabIds) {
    const rows = sessions[tabId]
    ordered[tabId] = Array.isArray(rows)
      ? [...rows].sort((left, right) => compareDesktopSessionOrder(left, right, tabId))
      : []
  }
  return ordered
}

function catalogueSeedValues(values: Record<string, string>): Record<string, string> {
  const seed: Record<string, string> = {}
  for (const key of KEYS) {
    if (values[key] !== undefined) seed[key] = values[key]
  }
  return seed
}

/** Re-materialize missing solo-chat rows from metadata only. */
export function recoverTranscriptSessions(
  values: Record<string, string>,
  workspaces: readonly RecoveryWorkspace[],
  transcripts: readonly ContinuityTranscriptEntry[],
): Record<string, string> {
  const sessions = parseRecord(values['crewcode:sessionsByTab'])
  const active = parseRecord(values['crewcode:activeSessionByTab'])
  const knownIds = new Set<string>()
  for (const rows of Object.values(sessions)) {
    for (const row of Array.isArray(rows) ? rows : []) {
      const id = row && typeof row === 'object' ? (row as { id?: unknown }).id : undefined
      if (typeof id === 'string') knownIds.add(id)
    }
  }
  const workspaceIds = workspaces.map(workspace => workspace.id)
  const workspaceById = new Map(workspaces.map(workspace => [workspace.id, workspace]))
  const transcriptByScope = new Map(transcripts.map(transcript => [transcript.scopeId, transcript]))
  let changed = false
  for (const transcript of transcripts) {
    const { scopeId } = transcript
    if (!scopeId || scopeId.length > 512 || knownIds.has(scopeId) || scopeId.startsWith('crew/')) continue
    const tabId = scopeId.replace(/::s\d+$/, '')
    const workspaceId = chatSessionOwnerWorkspaceId(tabId, workspaceIds)
    const workspace = workspaceId ? workspaceById.get(workspaceId) : undefined
    if (!workspace) continue
    const at = Number.isFinite(transcript.updatedAt) && transcript.updatedAt > 0 ? transcript.updatedAt : Date.now()
    const canonical = tabId === `${workspace.id}-chat`
    const row = {
      id: scopeId,
      tabId,
      label: recoveredSessionLabel(transcript, workspace.name, canonical, at),
      agentId: transcript.agentId?.trim().slice(0, 160) || 'pi',
      model: transcript.model?.trim().slice(0, 240) || '',
      mode: 'build',
      effort: 'medium',
      mcpServerIds: [],
      enabledSkillIds: [],
      modePromptsEnabled: true,
      createdAt: at,
      lastUsedAt: at,
      continuityRecovered: true,
    }
    const rows = Array.isArray(sessions[tabId]) ? [...sessions[tabId] as unknown[]] : []
    rows.push(row)
    sessions[tabId] = rows
    if (typeof active[tabId] !== 'string') active[tabId] = scopeId
    knownIds.add(scopeId)
    changed = true
  }
  for (const [tabId, rows] of Object.entries(sessions)) {
    if (!Array.isArray(rows)) continue
    const workspaceId = chatSessionOwnerWorkspaceId(tabId, workspaceIds)
    const workspace = workspaceId ? workspaceById.get(workspaceId) : undefined
    const next = rows.map(row => {
      if (!row || typeof row !== 'object' || !isRecoveredRow(row)) return row
      const candidate = row as CatalogueRow
      const id = typeof candidate.id === 'string' ? candidate.id : ''
      const transcript = id ? transcriptByScope.get(id) : undefined
      const at = typeof candidate.createdAt === 'number' && Number.isFinite(candidate.createdAt) ? candidate.createdAt : Date.now()
      const canonical = workspace ? tabId === `${workspace.id}-chat` : false
      const label = recoveredSessionLabel(transcript, workspace?.name ?? '', canonical, at)
      if (candidate.label === label) return row
      changed = true
      return { ...candidate, label }
    })
    sessions[tabId] = next
  }
  const ordered = orderSessionsMapOldestFirst(sessions)
  if (JSON.stringify(Object.keys(sessions)) !== JSON.stringify(Object.keys(ordered))) changed = true
  else {
    for (const tabId of Object.keys(ordered)) {
      if (JSON.stringify(sessions[tabId]) !== JSON.stringify(ordered[tabId])) changed = true
    }
  }
  if (!changed) return values
  return {
    ...values,
    'crewcode:sessionsByTab': JSON.stringify(ordered),
    'crewcode:activeSessionByTab': JSON.stringify(active),
  }
}

/** Remove browser-only recovery fallbacks before mirroring catalogue changes
 * to Brain. A recovered row becomes authoritative when a send clears its marker. */
export function stripRecoveredCatalogue(values: Record<string, string>): Record<string, string> {
  const sessions = parseRecord(values['crewcode:sessionsByTab'])
  const active = parseRecord(values['crewcode:activeSessionByTab'])
  const cleanSessions: Record<string, unknown[]> = {}
  const cleanActive: Record<string, string> = {}
  for (const [tabId, rows] of Object.entries(sessions)) {
    const clean = (Array.isArray(rows) ? rows : []).filter(row => !isSyntheticCatalogueRow(row))
    if (clean.length === 0) continue
    cleanSessions[tabId] = clean
    const ids = new Set(clean.flatMap(row => {
      const id = row && typeof row === 'object' ? (row as CatalogueRow).id : undefined
      return typeof id === 'string' ? [id] : []
    }))
    const activeId = active[tabId]
    if (typeof activeId === 'string' && ids.has(activeId)) cleanActive[tabId] = activeId
  }
  const next = { ...values }
  if (values['crewcode:sessionsByTab'] !== undefined) {
    if (Object.keys(cleanSessions).length === 0) {
      delete next['crewcode:sessionsByTab']
      delete next['crewcode:activeSessionByTab']
    } else {
      next['crewcode:sessionsByTab'] = JSON.stringify(cleanSessions)
      if (values['crewcode:activeSessionByTab'] !== undefined) next['crewcode:activeSessionByTab'] = JSON.stringify(cleanActive)
    }
  }
  return next
}

async function pushChanged(): Promise<void> {
  const runtime = getCrewCodeRuntime()
  if (runtime.kind === 'electron') return
  const next = stripRecoveredCatalogue(localValues())
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
  let values = runtime.kind === 'brain'
    ? mergeAttachedDesktopCatalogue(snapshot.values, local)
    : snapshot.values
  if (runtime.kind === 'brain') {
    const seed = catalogueSeedValues(values)
    const patch = Object.fromEntries(Object.entries(seed).filter(([key, value]) => snapshot.values[key] !== value))
    try {
      snapshot = api.continuityDesktopSeed
        ? await api.continuityDesktopSeed(seed)
        : Object.keys(patch).length > 0 ? await api.continuityStateUpdate(patch) : snapshot
      values = snapshot.values
    } catch {
      try {
        if (Object.keys(patch).length > 0) snapshot = await api.continuityStateUpdate(patch)
        values = snapshot.values
      } catch { /* merged desktop cache remains usable */ }
    }
  }
  try {
    const sessions = parseRecord(values['crewcode:sessionsByTab'])
    const needsTranscriptTitles = runtime.kind === 'web' && api.transcriptsCatalogue && (
      !values[DESKTOP_CATALOGUE_AUTHORITY_KEY] || catalogueHasRecoveredRows(sessions)
    )
    if (needsTranscriptTitles) {
      const [workspaces, transcripts] = await Promise.all([api.workspacesList(), api.transcriptsCatalogue()])
      values = recoverTranscriptSessions(values, workspaces, transcripts)
    }
  } catch { /* catalogue snapshot still hydrates without transcript recovery */ }
  for (const [key, value] of Object.entries(values)) {
    if ((KEYS as readonly string[]).includes(key)) localStorage.setItem(key, value)
  }
  lastValues = stripRecoveredCatalogue(localValues())
  installSync()
}
