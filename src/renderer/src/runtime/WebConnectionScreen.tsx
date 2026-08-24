import { useEffect, useState } from 'react'
import type { CrewCodeServerCapabilities } from '../../../shared/remote-access-types'
import App from '../App'
import { SettingsProvider } from '../hooks/useSettings'
import { NotificationsProvider } from '../hooks/useNotifications'
import { hydrateMessagesFromBackend } from '../stores/chat-messages-store'
import { installCrewCodeRuntime } from './crewcode-client'
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
  webRpc,
} from './web-rpc-client'

interface BrainExecutionSummary {
  bridgeId: string
  status: 'idle' | 'running' | 'completed' | 'blocked' | 'failed' | 'interrupted'
  attached: boolean
  provider?: string
  cwd?: string
  conversationScopeKey?: string
  lastEventAt: number
  droppedEvents: number
}

function pairingToken(): string {
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ''))
  return params.get('token') ?? ''
}

export function WebConnectionScreen() {
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
