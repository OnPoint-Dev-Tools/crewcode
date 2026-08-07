import { useEffect, useState } from 'react'
import type { CrewCodeServerCapabilities } from '../../../shared/remote-access-types'
import App from '../App'
import { SettingsProvider } from '../hooks/useSettings'
import { NotificationsProvider } from '../hooks/useNotifications'
import { installCrewCodeRuntime } from './crewcode-client'
import {
  clearWebSession,
  createWebCrewCodeClient,
  exchangePairingToken,
  fetchServerCapabilities,
  savedWebSession,
  webRpc,
} from './web-rpc-client'

function pairingToken(): string {
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ''))
  return params.get('token') ?? ''
}

export function WebConnectionScreen() {
  const [status, setStatus] = useState('Checking CrewCode server…')
  const [capabilities, setCapabilities] = useState<CrewCodeServerCapabilities | null>(null)
  const [connected, setConnected] = useState(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
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
        setConnected(true)
      } catch (error) {
        // A rejected restored session should return to the pairing state rather
        // than trapping the browser in a failed reconnect loop.
        if (!pairingToken()) clearWebSession()
        if (!cancelled) setStatus(`Could not connect: ${(error as Error).message}`)
      }
    })()
    return () => { cancelled = true }
  }, [])

  if (connected) {
    return (
      <SettingsProvider>
        <NotificationsProvider>
          <App />
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
