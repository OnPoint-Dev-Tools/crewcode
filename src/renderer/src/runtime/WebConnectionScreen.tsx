import { useCallback, useEffect, useState } from 'react'
import type { CrewCodeServerCapabilities } from '../../../shared/remote-access-types'
import App from '../App'
import CrewCodeMobileDashboard, { type MobileHubMachine } from '../components/ui/MobileDashboard'
import MobileMachineOverview, {
  type MobileMachineStats,
  type MobileRecentThread,
} from '../components/ui/MobileMachineOverview'
import { deriveMissionStats } from '../components/mission/mission-stats'
import type { AgentStatus } from '../components/mission/missionTypes'
import { SettingsProvider } from '../hooks/useSettings'
import { NotificationsProvider } from '../hooks/useNotifications'
import { useMobileLayout } from '../hooks/useMobileLayout'
import { hydrateMessagesFromBackend } from '../stores/chat-messages-store'
import { installCrewCodeRuntime } from './crewcode-client'
import { installBrainAuthorizationRelay } from './brain-authorization-runtime'
import { restoreRecoveredAssistant, type RecoveredAssistant } from './recovered-agent-history'
import { clearClaimedWebBridgeRoutes, markClaimedWebBridgeRoutes, rememberWebBridgeRoutes, webBridgeRoutes } from './web-bridge-routes'
import {
  connectHubRelayTransport,
  type HubRelayConnectionStatus,
  type ManagedHubRelayTransport,
} from './hub-relay-client'
import {
  clearWebSession,
  createWebCrewCodeClient,
  exchangePairingToken,
  fetchServerCapabilities,
  savedWebSession,
  WebRpcError,
  webRpc,
} from './web-rpc-client'

interface BrainExecutionSummary {
  bridgeId: string
  status: 'idle' | 'running' | 'completed' | 'blocked' | 'failed' | 'interrupted'
  attached: boolean
  provider?: string
  cwd?: string
  conversationScopeKey?: string
  createdAt?: number
  lastEventAt: number
  droppedEvents: number
}

interface MobileOverviewWorkspace {
  id: string
  name: string
  path: string
  branch: string | null
  kind: 'repo' | 'folder' | 'remote'
}

interface MobileOverviewWorktree {
  path: string
  branch: string
}

interface MobileOverviewWorktreeRecord extends MobileOverviewWorktree {
  projectId: string
}

interface RecentTranscriptSummary {
  scopeId: string
  updatedAt: number
  firstUserText: string | null
}

const EMPTY_MACHINE_STATS: MobileMachineStats = { worktrees: null, agents: null, running: null, done: null }

async function loadRecentTranscriptSummaries(
  relay: ManagedHubRelayTransport,
  fallbackMtimes: Promise<Record<string, number>>,
): Promise<RecentTranscriptSummary[]> {
  try {
    return await relay.transport.rpc<RecentTranscriptSummary[]>('transcripts.recent', { limit: 5 })
  } catch (cause) {
    // Brains started before transcripts.recent was added still expose the
    // metadata-only mtime index. Keep those sessions useful without falling
    // back to transcripts.loadAll, which would decrypt complete histories just
    // to render a five-row overview.
    if (!(cause instanceof WebRpcError) || cause.code !== 'UNSUPPORTED') throw cause
    const mtimes = await fallbackMtimes
    return Object.entries(mtimes)
      .filter((entry): entry is [string, number] => !!entry[0] && Number.isFinite(entry[1]))
      .sort((left, right) => right[1] - left[1])
      .slice(0, 5)
      .map(([scopeId, updatedAt]) => ({ scopeId, updatedAt, firstUserText: null }))
  }
}

function pairingToken(): string {
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ''))
  return params.get('token') ?? ''
}

async function hubMobileJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { cache: 'no-store', credentials: 'same-origin' })
  const body = await response.json() as T & { error?: string }
  if (response.status === 401) throw Object.assign(new Error('Hub sign-in is required'), { unauthenticated: true })
  if (!response.ok) throw new Error(body.error ?? `Hub request failed with ${response.status}`)
  return body
}

async function loadHubMobileSession(): Promise<string> {
  const session = await hubMobileJson<{ user?: { username?: string } }>('/api/v1/hub/session')
  return session.user?.username ?? ''
}

async function loadHubMobileMachines(): Promise<MobileHubMachine[]> {
  const result = await hubMobileJson<{ machines?: MobileHubMachine[] }>('/api/v1/hub/machines')
  return Array.isArray(result.machines) ? result.machines : []
}

function HubMobileHome() {
  const [username, setUsername] = useState('')
  const [machines, setMachines] = useState<MobileHubMachine[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      setMachines(await loadHubMobileMachines())
      setError(null)
    } catch (cause) {
      if ((cause as { unauthenticated?: boolean }).unauthenticated) {
        window.location.replace('/')
        return
      }
      setError((cause as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadHubMobileSession().then(setUsername).catch(cause => {
      if ((cause as { unauthenticated?: boolean }).unauthenticated) window.location.replace('/')
      else setError((cause as Error).message)
    })
    void refresh()
    const poll = window.setInterval(() => { if (document.visibilityState === 'visible') void refresh() }, 10_000)
    return () => window.clearInterval(poll)
  }, [refresh])

  return (
    <CrewCodeMobileDashboard
      username={username}
      machines={machines}
      loading={loading}
      error={error}
      onRefresh={() => { void refresh() }}
      onOpenHubSettings={() => window.location.assign('/?hub-admin=1')}
      onOpenMachine={machineId => window.location.assign(`/app?hub=mobile&machine=${encodeURIComponent(machineId)}`)}
    />
  )
}

function threadTitle(text: string | null): string {
  const normalized = text?.replace(/\s+/g, ' ').trim() ?? ''
  if (!normalized) return 'Untitled thread'
  return normalized.length > 52 ? `${normalized.slice(0, 51).trimEnd()}…` : normalized
}

function pathLeaf(value: string | undefined): string {
  if (!value) return ''
  const parts = value.split(/[\\/]/).filter(Boolean)
  return parts.at(-1) ?? value
}

function tabIdForScope(scopeId: string): string {
  return scopeId.includes('::') ? scopeId.slice(0, scopeId.indexOf('::')) : scopeId
}

function workspaceForThread(
  tabId: string,
  execution: BrainExecutionSummary | undefined,
  workspaces: MobileOverviewWorkspace[],
  worktrees: MobileOverviewWorktreeRecord[],
): MobileOverviewWorkspace | undefined {
  const byTab = workspaces
    .filter(workspace => tabId === workspace.id || tabId.startsWith(`${workspace.id}-`))
    .sort((left, right) => right.id.length - left.id.length)[0]
  if (byTab) return byTab
  const worktree = worktrees.find(item => item.path === execution?.cwd)
  return workspaces.find(workspace => workspace.path === execution?.cwd || workspace.id === worktree?.projectId)
}

function missionStatusForScope(scopeId: string, execution: BrainExecutionSummary | undefined): AgentStatus {
  if (execution?.status === 'running') return 'running'
  if (execution?.status === 'blocked') return 'blocked'
  // Mission Control's solo derivation returns idle after a completed turn.
  // Done is a crew-lane lifecycle state, not a generic bridge completion.
  if (scopeId.startsWith('crew/') && execution?.status === 'completed') return 'done'
  return 'idle'
}

async function loadMachineOverview(relay: ManagedHubRelayTransport): Promise<{
  stats: MobileMachineStats
  recentThreads: MobileRecentThread[]
  errors: string[]
}> {
  const transcriptMtimesRequest = relay.transport.rpc<Record<string, number>>('transcripts.mtimes', {})
  const [workspaceResult, executionResult, transcriptMtimesResult, transcriptResult] = await Promise.allSettled([
    relay.transport.rpc<MobileOverviewWorkspace[]>('workspaces.list', {}),
    relay.transport.rpc<{ executions: BrainExecutionSummary[] }>('bridge.list', {}),
    transcriptMtimesRequest,
    loadRecentTranscriptSummaries(relay, transcriptMtimesRequest),
  ])
  const errors = [workspaceResult, executionResult, transcriptMtimesResult, transcriptResult]
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map(result => (result.reason as Error).message)

  const workspaces = workspaceResult.status === 'fulfilled' ? workspaceResult.value : []
  const worktreeResults = workspaceResult.status === 'fulfilled'
    ? await Promise.allSettled(workspaces.filter(workspace => workspace.kind !== 'remote').map(async workspace => ({
      workspace,
      result: await relay.transport.rpc<{ worktrees?: MobileOverviewWorktree[]; error?: string }>('worktrees.list', { repoPath: workspace.path }),
    })))
    : []
  const rejectedWorktreeLookups = worktreeResults.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
  errors.push(...rejectedWorktreeLookups.map(result => (result.reason as Error).message))
  const worktrees: MobileOverviewWorktreeRecord[] = worktreeResults.flatMap(result => result.status === 'fulfilled'
    ? (result.value.result.worktrees ?? []).map(worktree => ({ ...worktree, projectId: result.value.workspace.id }))
    : [])
  const executions = executionResult.status === 'fulfilled' ? executionResult.value.executions : []
  const transcriptMtimes = transcriptMtimesResult.status === 'fulfilled' ? transcriptMtimesResult.value : {}
  const transcripts = transcriptResult.status === 'fulfilled' ? transcriptResult.value : []
  const detailForExecution = (execution: BrainExecutionSummary | undefined): string => {
    if (!execution) return 'Saved thread'
    const worktree = worktrees.find(item => item.path === execution.cwd)
    const workspace = workspaces.find(item => item.path === execution.cwd)
    const location = workspace?.name ?? pathLeaf(execution.cwd)
    const branch = worktree?.branch
    return [execution.provider ?? 'Agent', location, branch].filter(Boolean).join(' · ')
  }
  const recentThreads = transcripts.flatMap(transcript => {
    const execution = executions.find(item => item.conversationScopeKey === transcript.scopeId)
    const tabId = tabIdForScope(transcript.scopeId)
    // Crew-lane scopes need their persisted crew-session owner to navigate
    // correctly. Do not misrepresent one as a solo chat when that catalog is
    // unavailable on the pre-runtime overview.
    if (tabId.startsWith('crew/')) return []
    const workspace = workspaceForThread(tabId, execution, workspaces, worktrees)
    if (!workspace) return []
    const status: MobileRecentThread['status'] = execution?.status === 'running' || execution?.status === 'blocked'
      ? 'running'
      : 'saved'
    return {
      scopeId: transcript.scopeId,
      tabId,
      workspaceId: workspace.id,
      title: threadTitle(transcript.firstUserText),
      detail: detailForExecution(execution),
      updatedAt: transcript.updatedAt,
      status,
      ...(execution?.provider ? { agentId: execution.provider } : {}),
    }
  })
  const representedExecutions = new Set<string>()
  const missionAgents = Object.keys(transcriptMtimes).flatMap(scopeId => {
    const execution = executions.find(item => item.conversationScopeKey === scopeId)
    if (execution) representedExecutions.add(execution.bridgeId)
    const tabId = tabIdForScope(scopeId)
    const workspace = workspaceForThread(tabId, execution, workspaces, worktrees)
    if (!workspace) return []
    const worktree = worktrees.find(item => item.path === execution?.cwd)
    return [{
      status: missionStatusForScope(scopeId, execution),
      projectId: workspace.id,
      worktree: worktree?.path ?? (workspace.branch ? `wt-${workspace.branch}` : 'wt-main'),
      tokens: 0,
    }]
  })
  // A just-started agent may not have flushed its first transcript shard yet.
  // Include that observed live execution exactly once until persistence catches up.
  for (const execution of executions) {
    if (representedExecutions.has(execution.bridgeId)) continue
    const worktree = worktrees.find(item => item.path === execution.cwd)
    const workspace = workspaces.find(item => item.path === execution.cwd || item.id === worktree?.projectId)
    missionAgents.push({
      status: missionStatusForScope(execution.conversationScopeKey ?? '', execution),
      projectId: workspace?.id ?? worktree?.projectId ?? (pathLeaf(execution.cwd) || execution.bridgeId),
      worktree: worktree?.path ?? execution.cwd ?? execution.bridgeId,
      tokens: 0,
    })
  }
  const missionStats = deriveMissionStats(missionAgents)
  const stats: MobileMachineStats = workspaceResult.status === 'fulfilled'
    && executionResult.status === 'fulfilled'
    && transcriptMtimesResult.status === 'fulfilled'
    ? {
      worktrees: workspaceResult.status === 'fulfilled' && rejectedWorktreeLookups.length === 0 ? missionStats.worktrees : null,
      agents: missionStats.agents,
      running: missionStats.running,
      done: missionStats.done,
    }
    : EMPTY_MACHINE_STATS
  return { stats, recentThreads, errors }
}

function HubMobileMachineOverview({ machineId }: { machineId: string }) {
  const [machineName, setMachineName] = useState('Desktop')
  const [relay, setRelay] = useState<ManagedHubRelayTransport | null>(null)
  const [connected, setConnected] = useState(false)
  const [stats, setStats] = useState<MobileMachineStats>(EMPTY_MACHINE_STATS)
  const [recentThreads, setRecentThreads] = useState<MobileRecentThread[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async (activeRelay: ManagedHubRelayTransport | null) => {
    if (!activeRelay) return
    setLoading(true)
    try {
      const snapshot = await loadMachineOverview(activeRelay)
      setStats(snapshot.stats)
      setRecentThreads(snapshot.recentThreads)
      setError(snapshot.errors.length ? [...new Set(snapshot.errors)].join(' ') : null)
    } catch (cause) {
      setError((cause as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    let activeRelay: ManagedHubRelayTransport | null = null
    let disposeStatus: (() => void) | null = null
    void loadHubMobileMachines().then(machines => {
      if (!cancelled) setMachineName(machines.find(machine => machine.id === machineId)?.name ?? 'Desktop')
    }).catch(() => undefined)
    void connectHubRelayTransport(machineId, ['workspace:read', 'agent']).then(async nextRelay => {
      if (cancelled) { nextRelay.close(); return }
      activeRelay = nextRelay
      setRelay(nextRelay)
      disposeStatus = nextRelay.onStatus(status => {
        if (cancelled) return
        setConnected(status.state === 'connected')
        if (status.state === 'disconnected') {
          setStats(EMPTY_MACHINE_STATS)
          setError(status.message)
        }
      })
      await refresh(nextRelay)
    }).catch(cause => {
      if (!cancelled) { setError((cause as Error).message); setLoading(false) }
    })
    return () => {
      cancelled = true
      disposeStatus?.()
      activeRelay?.close()
    }
  }, [machineId, refresh])

  useEffect(() => {
    if (!relay) return
    const poll = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh(relay)
    }, 10_000)
    return () => window.clearInterval(poll)
  }, [refresh, relay])

  const enterCrewCode = (thread?: MobileRecentThread): void => {
    const query = new URLSearchParams({ machine: machineId })
    if (thread) {
      query.set('thread', thread.scopeId)
      query.set('threadTab', thread.tabId)
      query.set('threadWorkspace', thread.workspaceId)
      query.set('threadLabel', thread.title)
      if (thread.agentId) query.set('threadAgent', thread.agentId)
    }
    window.location.assign(`/app?${query.toString()}`)
  }

  return (
    <MobileMachineOverview
      machineName={machineName}
      connected={connected}
      stats={stats}
      recentThreads={recentThreads}
      loading={loading}
      error={error}
      onBack={() => window.location.assign('/app?hub=mobile')}
      onOpenSettings={() => window.location.assign('/?hub-admin=1')}
      onRefresh={() => { void refresh(relay) }}
      onEnterCrewCode={enterCrewCode}
    />
  )
}

function HubDesktopRedirect() {
  useEffect(() => { window.location.replace('/') }, [])
  return null
}

export function WebConnectionScreen() {
  const { isMobile } = useMobileLayout()
  const search = new URLSearchParams(window.location.search)
  const hubMobileHome = search.get('hub') === 'mobile'
  const machineId = search.get('machine')
  if (hubMobileHome) return isMobile
    ? machineId ? <HubMobileMachineOverview machineId={machineId} /> : <HubMobileHome />
    : <HubDesktopRedirect />
  return <WebRuntimeConnectionScreen />
}

function WebRuntimeConnectionScreen() {
  const [status, setStatus] = useState('Checking CrewCode server…')
  const [capabilities, setCapabilities] = useState<CrewCodeServerCapabilities | null>(null)
  const [connected, setConnected] = useState(false)
  const [relay, setRelay] = useState<ManagedHubRelayTransport | null>(null)
  const [relayStatus, setRelayStatus] = useState<HubRelayConnectionStatus | null>(null)
  const [brainExecutions, setBrainExecutions] = useState<BrainExecutionSummary[]>([])

  useEffect(() => {
    let cancelled = false
    let activeRelay: ManagedHubRelayTransport | null = null
    let disposeRelayStatus: (() => void) | null = null
    let executionPoll: ReturnType<typeof setInterval> | null = null
    let initialRelayRefreshComplete = false
    void (async () => {
      try {
        const machineId = new URLSearchParams(window.location.search).get('machine')
        if (machineId) {
          setStatus('Establishing an end-to-end encrypted Brain tunnel…')
          const connectedRelay = await connectHubRelayTransport(machineId, ['workspace:read', 'workspace:write', 'terminal', 'agent'])
          if (cancelled) { connectedRelay.close(); return }
          activeRelay = connectedRelay
          installBrainAuthorizationRelay(connectedRelay)
          clearClaimedWebBridgeRoutes()
          const refreshExecutions = async (claimDetached = false): Promise<void> => {
            try {
              const result = await connectedRelay.transport.rpc<{ executions: BrainExecutionSummary[] }>('bridge.list', {})
              rememberWebBridgeRoutes(result.executions.flatMap(execution => execution.conversationScopeKey
                ? [{ bridgeId: execution.bridgeId, tabId: execution.conversationScopeKey, cwd: execution.cwd, provider: execution.provider }]
                : []))
              let executions = result.executions
              if (claimDetached) {
                // Claim every stable chat execution, not only ones already
                // marked detached. During refresh Brain may not have observed
                // the old page closing yet; claim performs the same-owner
                // encrypted-session handoff atomically.
                const bridgeIds = executions.filter(execution => execution.conversationScopeKey).map(execution => execution.bridgeId)
                if (bridgeIds.length) {
                  const claimed = await connectedRelay.transport.rpc<{ claimed: string[] }>('bridge.claim', { bridgeIds })
                  const attached = new Set(claimed.claimed)
                  markClaimedWebBridgeRoutes(attached)
                  executions = executions.map(execution => attached.has(execution.bridgeId) ? { ...execution, attached: true } : execution)
                }
              }
              if (claimDetached) {
                // replayHistory covers a live process; recoverHistory covers the
                // same owner after a Brain restart erased its resource map but
                // left the Brain-local conversation shard intact.
                for (const execution of executions) {
                  if (execution.status !== 'completed' || !execution.conversationScopeKey) continue
                  const recovered = await connectedRelay.transport.rpc<{ latestAssistant: RecoveredAssistant | null }>('bridge.replayHistory', { bridgeId: execution.bridgeId })
                  restoreRecoveredAssistant(execution.conversationScopeKey, execution.bridgeId, recovered.latestAssistant)
                }
                for (const route of webBridgeRoutes()) {
                  const recovered = await connectedRelay.transport.rpc<{ latestAssistant: RecoveredAssistant | null }>('bridge.recoverHistory', {
                    bridgeId: route.bridgeId,
                    conversationScopeKey: route.tabId,
                  })
                  restoreRecoveredAssistant(route.tabId, route.bridgeId, recovered.latestAssistant)
                }
              }
              if (!cancelled) setBrainExecutions(executions)
            } catch { /* disconnect banner reports transport failure */ }
          }
          disposeRelayStatus = connectedRelay.onStatus(next => {
            setRelayStatus(next)
            if (next.state === 'connected' && initialRelayRefreshComplete) void refreshExecutions(true)
          })
          executionPoll = setInterval(() => { void refreshExecutions() }, 10_000)
          setRelay(connectedRelay)
          const client = createWebCrewCodeClient(connectedRelay.transport)
          installCrewCodeRuntime({ kind: 'web', client })
          // Hydrate the authoritative browser transcript first, then merge any
          // reply that completed in Brain custody while the page was absent.
          // Doing this in the opposite order lets hydration overwrite recovery.
          await hydrateMessagesFromBackend()
          await refreshExecutions(true)
          initialRelayRefreshComplete = true
          await client.workspacesList()
          setStatus(`Connected with Brain-local scopes: ${connectedRelay.grantedScopes.join(', ') || 'none'}`)
          setConnected(true)
          return
        }
        const nextCapabilities = await fetchServerCapabilities()
        if (cancelled) return
        setCapabilities(nextCapabilities)
        let session = savedWebSession()
        const token = pairingToken()
        if (token) {
          setStatus('Pairing this browser…')
          session = await exchangePairingToken(token)
          history.replaceState(null, '', `${window.location.pathname}${window.location.search}`)
        }
        if (!session) {
          setStatus('Server found. Open the pairing URL printed in the server terminal.')
          return
        }
        // Validate a restored credential before installing the privileged client.
        await webRpc(session, 'workspaces.list', {})
        if (cancelled) return
        installCrewCodeRuntime({ kind: 'web', client: createWebCrewCodeClient(session) })
        await hydrateMessagesFromBackend()
        setConnected(true)
      } catch (error) {
        // A rejected restored session should return to the pairing state rather
        // than trapping the browser in a failed reconnect loop.
        if (!pairingToken()) clearWebSession()
        if (!cancelled) setStatus(`Could not connect: ${(error as Error).message}`)
      }
    })()
    return () => {
      cancelled = true
      disposeRelayStatus?.()
      if (executionPoll) clearInterval(executionPoll)
      activeRelay?.close()
    }
  }, [])

  if (connected) {
    const relayInterrupted = relayStatus?.state === 'disconnected'
    return (
      <SettingsProvider>
        <NotificationsProvider>
          <App />
          {brainExecutions.length > 0 && (
            <aside style={{ position: 'fixed', zIndex: 9999, right: 12, bottom: 12, maxWidth: 420, padding: '10px 14px', border: '1px solid #31524a', background: '#101a17ee', color: '#cfe1da', fontSize: 12 }}>
              <strong>Brain executions</strong>
              {brainExecutions.map(execution => (
                <div key={execution.bridgeId} style={{ marginTop: 4 }}>
                  {execution.provider ?? 'agent'} · {execution.status}{execution.attached ? '' : ' · detached'}
                  {execution.droppedEvents > 0 ? ` · ${execution.droppedEvents} old events omitted` : ''}
                </div>
              ))}
            </aside>
          )}
          {relayStatus && relayStatus.state !== 'connected' && (
            <aside role="alert" style={{ position: 'fixed', zIndex: 10000, inset: '12px 12px auto 12px', padding: '12px 16px', border: '1px solid #9a6b32', background: '#211a12', color: '#f0dfc2', boxShadow: '0 4px 18px #0008' }}>
              <strong>{relayInterrupted ? 'Brain connection interrupted' : 'Reconnecting to Brain…'}</strong>
              {relayInterrupted && <span style={{ marginLeft: 8 }}>{relayStatus.message} Brain-owned terminal and agent resources remain detached until secure reconnection.</span>}
              {relayInterrupted && relay && (
                <button
                  type="button"
                  style={{ marginLeft: 12 }}
                  onClick={() => { void relay.reconnect().catch(() => undefined) }}
                >
                  Reconnect securely
                </button>
              )}
            </aside>
          )}
        </NotificationsProvider>
      </SettingsProvider>
    )
  }

  return (
    <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: '#0f120f', color: '#d7e0dc', fontFamily: 'Inter, sans-serif', padding: 24 }}>
      <section style={{ width: 'min(520px, 100%)', border: '1px solid #1c2f2f', padding: 24 }}>
        <h1 style={{ marginTop: 0, fontSize: 22 }}>CrewCode Remote</h1>
        <p>{status}</p>
        {capabilities && (
          <p style={{ color: '#8da49a', fontFamily: 'JetBrains Mono, monospace', fontSize: 12 }}>
            protocol v{capabilities.protocolVersion} · {capabilities.platform} · secure remote session
          </p>
        )}
        <p style={{ color: '#8da49a', fontSize: 13 }}>
          Pairing links are single-use. This browser stores the resulting device session locally; provider credentials never leave the server.
        </p>
      </section>
    </main>
  )
}
