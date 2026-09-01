import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { SettingsProvider } from './hooks/useSettings'
import { NotificationsProvider } from './hooks/useNotifications'
import { initializeCrewCodeRuntime, installCrewCodeRuntime } from './runtime/crewcode-client'
import { WebConnectionScreen } from './runtime/WebConnectionScreen'
import { createBrainAttachedCrewCodeClient } from './runtime/web-rpc-client'
import { hydrateContinuityState } from './runtime/continuity-state'
import './styles/fonts'
import './styles/colors_and_type.css'
import './styles/tailwind.css'
import './styles/styles.css'
import './styles/add-project-modal.css'
import './styles/settings.css'
import './styles/git-sidebar.css'
import './styles/crew-config.css'
import './styles/crew-surface.css'
import './styles/crew-diff.css'
import './styles/crew-git-sidebar.css'
// Loaded after both consumers so the shared gate wins over their older
// per-surface collision rules while those are being retired.
import './styles/crew-collision-review.css'
import './styles/turn-changes.css'
import './styles/prompt-builder.css'
import './styles/mission-control.css'
import './styles/system-monitor.css'
// import 'react-grab/styles.css'

// FOR DEV ENVIRONMENT //
// void import('react-grab').then(({ init }) => init()).catch(() => {
//   /* keep the app booting even if react-grab is unavailable */
// })

// Electron 42 / Chromium may reference this global from native app-region
// drag callbacks. Assign it from the external module bundle so the web server's
// strict CSP never needs to permit inline script execution.
;(window as Window & { dragEvent?: unknown }).dragEvent = undefined

const isElectronRuntime = !!window.electronAPI

function setStartupStatus(message: string): void {
  const caption = document.getElementById('startup-screen-caption')
  if (caption) caption.textContent = message
}

// Warm every declared web-font face at idle so the browser fetches/rasterizes
// them up front. Without this, a font face is only loaded the first time text
// uses it — which lands mid-interaction on font-heavy pages (Settings) and
// stalls the post-commit paint by a few hundred ms. display=swap means the
// fallback still paints immediately; we just front-load the swap work.
function warmFonts(): void {
  if (!('fonts' in document)) return
  const FAMILIES = ['Inter', 'JetBrains Mono', 'Fira Code', 'IBM Plex Mono', 'Roboto Mono', 'Source Code Pro']
  const WEIGHTS = [400, 500, 600, 700]
  void Promise.allSettled(
    FAMILIES.flatMap(f => WEIGHTS.map(w => document.fonts.load(`${w} 14px "${f}"`))),
  )
}
if ('requestIdleCallback' in window) (window as any).requestIdleCallback(warmFonts)
else setTimeout(warmFonts, 1500)

if ('serviceWorker' in navigator && !isElectronRuntime) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {})
  })
}

async function bootstrap(): Promise<void> {
  // Install the transport before any hook can issue a privileged request.
  // An enabled local Brain keeps Electron's native integrations but becomes
  // the durable backend, matching the web client's workspace/transcript/agent
  // contract. Failure to probe it falls back to the legacy local runtime.
  if (isElectronRuntime) {
    const local = window.electronAPI!
    try {
      setStartupStatus('checking background Brain')
      const status = await local.brainDesktopStatus()
      if (status.attached) {
        setStartupStatus('connecting to background Brain')
        installCrewCodeRuntime({ kind: 'brain', client: createBrainAttachedCrewCodeClient(local) })
        setStartupStatus('restoring workspaces and conversations')
        await hydrateContinuityState()
      } else {
        setStartupStatus('loading local workspace')
        initializeCrewCodeRuntime()
      }
    } catch {
      setStartupStatus('loading local workspace')
      initializeCrewCodeRuntime()
    }
  }

  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      {isElectronRuntime ? (
        <SettingsProvider>
          <NotificationsProvider>
            <App />
          </NotificationsProvider>
        </SettingsProvider>
      ) : <WebConnectionScreen />}
    </React.StrictMode>
  )
}

void bootstrap()
