import electron from 'electron'
import { join } from 'path'
import { spawnSync } from 'child_process'
import { existsSync } from 'fs'
import os from 'os'

import { registerPtyIpc, killAllPanes } from './pty'
import { registerWorkspaceIpc } from './workspaceStore'
import { registerFsIpc } from './fs'
import { registerWriterDocumentIpc } from './writer-documents'
import { registerEditorWatchIpc, stopAllEditorWatchers } from './editor-file-watch'
import { registerEditorLanguageServerIpc, stopAllEditorLanguageServers } from './editor-language-server'
import { registerGitIpc } from './git'
import { registerAgentBridgeIpc, stopAllBridges } from './agents'
import { getAgentKey, setAgentKey, hasAgentKey } from './agents/agent-keys'
import { listModels } from './agents/model-detect'
import { registerUpdaterIpc } from './updater'
import { registerGhIpc, killActiveGhLogin } from './gh'
import { getGitHubStatus } from './github-service'
import { registerSshIpc, resolveSshAgentAtStartup, killManagedSshAgent } from './ssh'
import { registerRemoteIpc, disconnectAllRemotes } from './remote/remote-ipc'
import { registerCustomCommandsIpc } from './customCommands'
import { registerMcpConfigIpc } from './mcpConfig'
import { registerKeybindsIpc } from './keybindsFile'
import { PLUGIN_PROTOCOL, loadPluginRegistry, registerPluginIpc, registerPluginProtocol } from './plugins'
import { APP_CSP, SECURE_WINDOW_WEB_PREFERENCES, isAllowedExternalScheme } from './security-config'
import { registerSystemStatsIpc } from './systemStats'
import { registerTranscriptIpc } from './transcript-store'
import { browserGrabManager } from './browser/browser-grab-manager'
import { parsePorcelainWorktrees } from './worktree-list-parse'
import { addWorktree, removeWorktree } from './worktree-ops'
import { delegationService } from './delegation-service'
import { DEFAULT_MAX_CONCURRENT } from './delegation-routes'
import type { ModeLevel } from '../shared/mode-types'

/** Persisted/renderer-supplied modes can still be the pre-rename `yolo`, and a
 *  malformed value must not become an unrecognized permission level. */
function normalizeDelegationMode(value: unknown): ModeLevel {
  if (value === 'yolo' || value === 'full') return 'full'
  if (value === 'ask' || value === 'plan' || value === 'build') return value
  return 'build'
}
import { RateLimitService, registerRateLimitIpc } from './rate-limits'
import { registerNotificationIpc, setNotificationIcon } from './notify'
import { getYuHeardServer } from './yuheard-server'
import {
  createVoiceClientSecret,
  setVoiceProviderKey,
  synthesizeRemoteVoiceText,
  transcribeRemoteVoiceAudio,
  voiceProviderAvailability,
} from './voice-provider-auth'
import {
  normalizeLocalVoiceSpeed,
  type LocalVoiceStartRequest,
  type LocalVoiceWarmupCapability,
  type RemoteVoiceProviderId,
  type VoiceClientSecretRequest,
  type VoiceSpeechRequest,
  type VoiceTranscriptionRequest,
} from '../shared/voice-types'
import { localVoiceService } from './local-voice-service'
import { packagedHeadlessArgs } from './packaged-cli-dispatch'

const { app, BrowserWindow, clipboard, ipcMain, nativeImage, protocol, session, shell } = electron
import { spawn } from 'child_process'

// The packaged AppImage executable is also named `crewcode`. Dispatch recognized
// server commands in the main process with all window initialization disabled:
// `crewcode` remains desktop, while `crewcode hub|serve|brain|enroll` is headless.
// Running here (rather than ELECTRON_RUN_AS_NODE) preserves compatibility for
// shared backend modules that intentionally import Electron's app-path adapter.
const packagedCliArgs = app.isPackaged ? packagedHeadlessArgs(process.argv) : null
if (packagedCliArgs) {
  const [command, ...args] = packagedCliArgs
  const run = command === 'hub'
    ? import('./hub').then(module => module.runHub(args))
    : command === 'serve'
      ? import('./headless').then(module => module.runHeadless(args))
      : import('./hub-machine-enrollment').then(module => module.runBrainCommand(command as 'brain' | 'enroll', args))
  void run.then(() => {
    // Long-running Hub/direct servers return after binding and remain alive on
    // their sockets. Help and enrollment are finite commands and should exit.
    if (command === 'enroll' || args.includes('--help') || args.includes('-h')) app.exit(0)
  }).catch(error => {
    console.error((error as Error).message)
    app.exit(1)
  })
}

const isDev = process.env['NODE_ENV'] === 'development'

function isWaylandSession(): boolean {
  return process.platform === 'linux' && (
    process.env['XDG_SESSION_TYPE'] === 'wayland' ||
    !!process.env['WAYLAND_DISPLAY'] ||
    process.env['ELECTRON_OZONE_PLATFORM_HINT'] === 'wayland'
  )
}

// Plugin panels use a custom protocol because the dev renderer is http:// and
// Chromium blocks file:// iframes from that origin.
protocol.registerSchemesAsPrivileged([
  { scheme: PLUGIN_PROTOCOL, privileges: { standard: true, secure: true, supportFetchAPI: true } },
])

// ─── Content-Security-Policy ───────────────────────────────────────────────────
// Defense-in-depth backstop for the renderer: blocks injected inline scripts and
// `javascript:` navigations even if untrusted content slips into the DOM. Applied
// only in production — Vite's dev server needs eval/inline/websocket for HMR.
// `wasm-unsafe-eval` is required by shiki's oniguruma WASM; the sha256 hash whitelists
// the one inline bootstrap script in index.html. Plugin assets (crewcode-plugin://)
// ship their own stricter CSP and webview guests run in separate partitions, so
// both are left untouched here. The directive list lives in ./security-config
// (pure + test-guarded so it cannot be silently weakened).
function applyContentSecurityPolicy(): void {
  if (isDev) return
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    // Leave plugin-protocol responses on their own (stricter) CSP.
    if (details.url.startsWith(`${PLUGIN_PROTOCOL}://`)) {
      callback({ responseHeaders: details.responseHeaders })
      return
    }
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [APP_CSP],
      },
    })
  })
}

// ─── Window ──────────────────────────────────────────────────────────────────

function createWindow(): electron.BrowserWindow {
  const iconPath = isDev
    ? join(__dirname, '../../build/icons/512x512.png')
    : join(process.resourcesPath, 'build/icons/512x512.png')
  setNotificationIcon(iconPath)

  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    frame: false,
    backgroundColor: '#0f120f',
    icon: nativeImage.createFromPath(iconPath),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      ...SECURE_WINDOW_WEB_PREFERENCES,
      webviewTag: true,
    }
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url)
      if (isAllowedExternalScheme(parsed.protocol)) {
        void shell.openExternal(url)
      }
    } catch { /* deny malformed popup URLs */ }
    return { action: 'deny' }
  })

  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
    // Auto-open DevTools in dev so the React Profiler is one click away. Detached
    // so it doesn't squeeze the frameless UI.
    win.webContents.openDevTools({ mode: 'detach' })
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}

// Electron 42 deprecated the old session extension APIs used by
// electron-devtools-installer, and on Linux/Wayland the downloaded DevTools
// extension has also been a source of startup noise and renderer stalls. Keep
// detached Chromium DevTools, but make the React extension an explicit opt-in.
async function loadReactDevtools(): Promise<void> {
  if (!isDev || process.env['CREWCODE_REACT_DEVTOOLS'] !== '1') return
  console.warn('[devtools] React DevTools auto-install is disabled on Electron 42; use CREWCODE_REACT_DEVTOOLS=1 only after migrating to session.extensions.* APIs.')
}

if (!packagedCliArgs && isWaylandSession()) {
  // Chromium's Vulkan surface path can be unstable on Wayland/NVIDIA; keep
  // Wayland enabled while avoiding that compatibility path.
  app.commandLine.appendSwitch('disable-vulkan-surface')
}

if (!packagedCliArgs) app.whenReady().then(async () => {
  registerPtyIpc()
  registerWorkspaceIpc()
  registerFsIpc()
  registerWriterDocumentIpc()
  registerEditorWatchIpc()
  registerEditorLanguageServerIpc()
  registerGitIpc()
  registerAgentBridgeIpc((id) => agentPaths[id] ?? null)
  registerUpdaterIpc()
  registerGhIpc()
  registerSshIpc()
  registerRemoteIpc()
  resolveSshAgentAtStartup()
  registerCustomCommandsIpc()
  registerMcpConfigIpc()
  registerKeybindsIpc()
  registerPluginProtocol()
  registerPluginIpc()
  registerSystemStatsIpc()
  registerTranscriptIpc()
  registerRateLimitIpc(rateLimitService)
  registerNotificationIpc()

  applyContentSecurityPolicy()

  await loadReactDevtools()
  const win = createWindow()
  rateLimitService.attach(win)
  rateLimitService.start()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const nextWin = createWindow()
      rateLimitService.attach(nextWin)
    }
  })
})

// Harden any <webview> guest (the in-app browser): never give it a Node preload
// or node integration, regardless of attributes the renderer sets. The browser
// tab already runs without these, so this only forecloses an escape route.
app.on('web-contents-created', (_e, contents) => {
  contents.on('will-attach-webview', (_evt, webPreferences) => {
    delete webPreferences.preload
    Object.assign(webPreferences, SECURE_WINDOW_WEB_PREFERENCES)
  })
})

app.on('window-all-closed', () => {
  killAllPanes()
  stopAllBridges()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  killAllPanes()
  stopAllBridges()
  stopAllEditorWatchers()
  stopAllEditorLanguageServers()
  killActiveGhLogin()
  killManagedSshAgent()
  disconnectAllRemotes()
  rateLimitService.stop()
  localVoiceService.stop()
  // Closes the loopback socket and drops every minted token.
  delegationService.stop()
})

// ─── Window controls ─────────────────────────────────────────────────────────

ipcMain.on('win:minimize', (e) => BrowserWindow.fromWebContents(e.sender)?.minimize())
ipcMain.on('win:maximize', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender)
  if (!win) return
  win.isMaximized() ? win.unmaximize() : win.maximize()
})
ipcMain.on('win:close', (e) => BrowserWindow.fromWebContents(e.sender)?.close())

// ─── Agent detection ─────────────────────────────────────────────────────────

interface AgentDef {
  id:        string
  name:      string
  cmd:       string
  transport: 'pty' | 'bridge'   // bridge = structured stream; pty = raw terminal
  // Hosted provider reached over HTTP with a stored API key — no binary to
  // detect, so availability is driven by whether a key is set, not PATH.
  apiKeyProvider?: boolean
}

// Completion-only hosted APIs are deliberately kept out of AGENT_DEFS so they
// cannot be selected as normal chat providers.
const COMPLETION_API_KEY_IDS = new Set(['opencode-go'])

export const AGENT_DEFS: AgentDef[] = [
  { id: 'pi',         name: 'pi',          cmd: 'pi',       transport: 'bridge' },
  { id: 'opencode',   name: 'OpenCode',    cmd: 'opencode-cli', transport: 'bridge' },
  { id: 'claude',     name: 'Claude Agent', cmd: 'claude',   transport: 'bridge' },
  { id: 'codex',      name: 'Codex',       cmd: 'codex',    transport: 'bridge' },
  { id: 'hermes',     name: 'Hermes',      cmd: 'hermes',   transport: 'bridge' },
  { id: 'crewcoder',  name: 'CrewCoder',   cmd: 'crewcoder', transport: 'bridge' },
  { id: 'grok',       name: 'Grok Build',  cmd: 'grok',     transport: 'bridge' },
  { id: 'ollama',     name: 'Ollama',      cmd: 'ollama',   transport: 'bridge' },
  { id: 'openrouter', name: 'OpenRouter',  cmd: '',         transport: 'bridge', apiKeyProvider: true },
]

// Bounded so a slow or input-waiting shell rc cannot stall app startup — this
// runs synchronously for every provider before the window opens.
const SHELL_PROBE_TIMEOUT_MS = 3_000

function probeShell(shell: string, flags: string, cmd: string): string | null {
  try {
    const res = spawnSync(shell, [flags, `command -v ${cmd}`], {
      encoding: 'utf8',
      timeout:  SHELL_PROBE_TIMEOUT_MS,
    })
    // Take the last stdout line: rc files can print banners before the answer.
    const found = res.stdout?.trim().split('\n').pop()?.trim()
    return found && existsSync(found) ? found : null
  } catch {
    return null
  }
}

function detectAgentPath(cmd: string): string | null {
  // 1) Try Electron's own PATH first (covers /usr/bin, /usr/local/bin, etc.)
  const which = spawnSync('which', [cmd], { encoding: 'utf8', timeout: SHELL_PROBE_TIMEOUT_MS })
  const fromPath = which.stdout?.trim()
  if (fromPath && existsSync(fromPath)) return fromPath

  // 2) Re-query through the user's shell so we pick up version-manager shims
  //    (mise, asdf, volta, fnm, bun, etc.) missing from Electron's env when the
  //    app is launched from a desktop/dock entry rather than a terminal.
  //
  //    Both -lc and -ic are needed: a login shell reads ~/.bash_profile and
  //    ~/.profile, while most PATH exports actually live in ~/.bashrc or
  //    ~/.zshrc, which only an interactive shell sources. Trying only -lc was
  //    why providers resolved in dev (launched from a terminal, so step 1 hit)
  //    but vanished in packaged builds.
  const shell = process.env.SHELL || '/bin/bash'
  const fromLogin = probeShell(shell, '-lc', cmd)
  if (fromLogin) return fromLogin
  const fromInteractive = probeShell(shell, '-ic', cmd)
  if (fromInteractive) return fromInteractive

  // 3) Probe well-known install locations as a last resort.
  const home = os.homedir()
  // Bun honours $BUN_INSTALL and is not always at ~/.bun (e.g. ~/.cache/.bun).
  const bunRoots = [process.env.BUN_INSTALL, join(home, '.bun'), join(home, '.cache', '.bun')]
  const candidates = [
    join(home, `.${cmd}`,        'bin', cmd),
    join(home, '.local',         'bin', cmd),
    join(home, '.local', 'share', 'com.crew-code.desktop', `${cmd}-cli`, cmd),
    join(home, '.local', 'share', cmd, 'bin', cmd),
    join(home, '.local', 'share', 'mise',  'shims', cmd),
    join(home, '.asdf',          'shims', cmd),
    join(home, '.volta',         'bin',   cmd),
    join(home, '.fnm',           'aliases', 'default', 'bin', cmd),
    ...bunRoots.filter(Boolean).map(root => join(root as string, 'bin', cmd)),
    join(home, '.cargo',         'bin', cmd),
    join(home, '.npm-global',    'bin', cmd),
    `/usr/local/bin/${cmd}`,
    `/opt/${cmd}/bin/${cmd}`,
    `/opt/homebrew/bin/${cmd}`,
  ]
  for (const c of candidates) {
    try { if (existsSync(c)) return c } catch { /* skip */ }
  }
  return null
}

// Auto-detected paths (resolved once at startup). Effective `agentPaths` may be
// overridden by the renderer via `agent:setPath` — the override wins.
const defaultAgentPaths: Record<string, string | null> = {}
const agentPaths:        Record<string, string | null> = {}
for (const def of AGENT_DEFS) {
  // Hosted providers have no binary — skip PATH detection entirely.
  const detected = def.apiKeyProvider ? null : detectAgentPath(def.cmd)
  defaultAgentPaths[def.id] = detected
  agentPaths[def.id]        = detected
}

const rateLimitService = new RateLimitService((provider) => agentPaths[provider] ?? null)

function registrySnapshot() {
  const builtin = AGENT_DEFS.map(def => ({
    id:          def.id,
    name:        def.name,
    cmd:         def.cmd,
    path:        agentPaths[def.id],
    defaultPath: defaultAgentPaths[def.id],
    // Hosted providers are "available" once their key is set; CLI providers
    // once their binary resolves.
    available:   def.apiKeyProvider ? hasAgentKey(def.id) : agentPaths[def.id] !== null,
    transport:   def.transport,
    source:      'builtin' as const,
    requiresApiKey: !!def.apiKeyProvider,
    hasKey:      def.apiKeyProvider ? hasAgentKey(def.id) : undefined,
  }))
  const pluginAgents = loadPluginRegistry().contributions.agentProviders.map(provider => ({
    id:          `plugin:${provider.registrationId}` as const,
    name:        provider.title,
    cmd:         undefined,
    path:        null,
    defaultPath: null,
    available:   true,
    transport:   'bridge' as const,
    source:      'plugin' as const,
    pluginId:    provider.pluginId,
    description: provider.description ?? `plugin agent provider · ${provider.pluginId}`,
  }))
  return [...builtin, ...pluginAgents]
}

ipcMain.handle('agent:registry', () => registrySnapshot())

// YuHeard status — exposed so the renderer can show the socket path in
// settings and link to docs/yuheard.md. Returns `{ socket, running }`;
// the socket path is null if the server failed to start.
ipcMain.handle('yuheard:status', () => {
  const server = getYuHeardServer()
  return {
    socket: server?.getSocketPath() ?? null,
    running: !!server?.isRunning(),
  }
})

ipcMain.handle('agent:setPath', (_e, id: string, path: string | null) => {
  if (!AGENT_DEFS.some(d => d.id === id)) return { ok: false, error: 'unknown agent id' }
  if (path === null || path === '') {
    agentPaths[id] = defaultAgentPaths[id]
    if (id === 'claude' || id === 'codex' || id === 'opencode') void rateLimitService.refresh()
    return { ok: true, registry: registrySnapshot() }
  }
  // Allow override even if file doesn't exist yet (user may be typing). The
  // renderer surfaces the `available` flag so they see when it resolves.
  const expanded = path.startsWith('~') ? path.replace('~', os.homedir()) : path
  agentPaths[id] = existsSync(expanded) ? expanded : null
  if (id === 'claude' || id === 'codex' || id === 'opencode') void rateLimitService.refresh()
  return { ok: true, registry: registrySnapshot(), resolved: agentPaths[id] }
})

ipcMain.handle('agent:listModels', (_e, provider: string) =>
  listModels(provider, agentPaths[provider] ?? null)
)

// API keys for hosted providers (OpenRouter, …). getKey returns the raw value
// so the settings field can show/edit it on this single-user desktop machine;
// setKey persists (or clears on empty) and returns a fresh registry snapshot so
// availability flips immediately.
ipcMain.handle('agent:getKey', (_e, id: string) => ({ key: getAgentKey(id) }))

ipcMain.handle('agent:setKey', (_e, id: string, key: string | null) => {
  if (!AGENT_DEFS.some(d => d.id === id && d.apiKeyProvider) && !COMPLETION_API_KEY_IDS.has(id)) return { ok: false, error: 'agent does not take an API key' }
  setAgentKey(id, key)
  if (id === 'openrouter') void rateLimitService.refresh()
  return { ok: true, registry: registrySnapshot() }
})

// Voice keys stay main-side. The renderer can replace/clear them and request a
// short-lived client credential, but it can never read a stored permanent key.
ipcMain.handle('voice:providerAvailability', () => voiceProviderAvailability())

ipcMain.handle('voice:setProviderKey', (_e, provider: RemoteVoiceProviderId, key: string | null) => {
  if (provider !== 'openai' && provider !== 'xai') return { ok: false, error: 'unsupported voice provider' }
  setVoiceProviderKey(provider, key)
  return { ok: true, availability: voiceProviderAvailability() }
})

ipcMain.handle('voice:createClientSecret', (_e, request: VoiceClientSecretRequest) => {
  if (request?.provider !== 'openai' && request?.provider !== 'xai') {
    return { ok: false, provider: request?.provider ?? 'openai', error: 'unsupported voice provider' }
  }
  return createVoiceClientSecret(request)
})

ipcMain.handle('voice:transcribe', async (_e, request: VoiceTranscriptionRequest) => {
  if (!request || !(request.audio instanceof Uint8Array) || request.audio.byteLength === 0) {
    return { ok: false, error: 'Invalid dictation audio.' }
  }
  if (request.audio.byteLength > 32 * 1024 * 1024) {
    return { ok: false, error: 'Dictation audio is too large.' }
  }
  if (request.provider === 'openai' || request.provider === 'xai') {
    return transcribeRemoteVoiceAudio(request.provider, request.audio)
  }
  if (request.provider === 'local') {
    const status = await localVoiceService.prewarm(
      request.localPythonPath ?? '',
      request.localDevice ?? 'auto',
      'transcription',
    )
    if (!status.ready) return { ok: false, error: status.error ?? 'Local voice service is unavailable.' }
    return localVoiceService.transcribe(request.audio)
  }
  if (request.provider === 'fake' && isDev) {
    return { ok: true, text: 'Fake dictation transcript.' }
  }
  return { ok: false, error: 'Choose an available voice provider in Settings.' }
})

ipcMain.handle('voice:synthesize', async (_e, request: VoiceSpeechRequest) => {
  if (!request || typeof request.text !== 'string' || typeof request.voice !== 'string') {
    return { ok: false, error: 'Invalid speech request.' }
  }
  if (request.provider === 'openai' || request.provider === 'xai') {
    return synthesizeRemoteVoiceText(request.provider, request.text, request.voice)
  }
  if (request.provider === 'local') {
    const status = await localVoiceService.prewarm(
      request.localPythonPath ?? '',
      request.localDevice ?? 'auto',
      'speech',
    )
    if (!status.ready) return { ok: false, error: status.error ?? 'Local voice service is unavailable.' }
    const result = await localVoiceService.synthesize(
      request.text,
      request.voice,
      normalizeLocalVoiceSpeed(request.localSpeed),
    )
    return result.ok ? { ...result, contentType: 'audio/wav' } : result
  }
  return { ok: false, error: 'Choose Local, GPT, or xAI under Settings → Voice.' }
})

ipcMain.handle('voice:localStart', (_e, request: LocalVoiceStartRequest) => {
  if (!request || typeof request.pythonPath !== 'string' || !['auto', 'gpu', 'cpu'].includes(request.device)) {
    return { running: false, ready: false, endpoint: '', error: 'Invalid local voice configuration.' }
  }
  return localVoiceService.start(request.pythonPath, request.device)
})
ipcMain.handle(
  'voice:localPrewarm',
  (_e, request: LocalVoiceStartRequest, capability: LocalVoiceWarmupCapability) => {
    if (!request || typeof request.pythonPath !== 'string'
      || !['auto', 'gpu', 'cpu'].includes(request.device)
      || !['transcription', 'speech', 'all'].includes(capability)) {
      return { running: false, ready: false, endpoint: '', error: 'Invalid local voice warmup capability.' }
    }
    return localVoiceService.prewarm(request.pythonPath, request.device, capability)
  },
)
ipcMain.handle('voice:localStatus', () => localVoiceService.status())
ipcMain.handle('voice:localTranscribe', (_e, audio: Uint8Array) => {
  if (!(audio instanceof Uint8Array)) return { ok: false, error: 'Invalid local voice audio.' }
  return localVoiceService.transcribe(audio)
})
ipcMain.handle('voice:localSynthesize', (_e, text: string, voice: string, speed?: number) => {
  if (typeof text !== 'string' || typeof voice !== 'string') return { ok: false, error: 'Invalid local speech request.' }
  return localVoiceService.synthesize(text, voice, normalizeLocalVoiceSpeed(speed))
})

function expandHome(p: string): string {
  return p.startsWith('~') ? p.replace('~', os.homedir()) : p
}

// ─── Git worktree management ──────────────────────────────────────────────────
// Parsing + the create/remove command sequences live in worktree-list-parse.ts
// and worktree-ops.ts so they're unit-testable without Electron. These handlers
// are thin IPC wrappers over those.

// ─── Delegation API ───────────────────────────────────────────────────────────
// The loopback server is created lazily by the first `enable` and torn down when
// the last session disables (or on quit), so a user who never turns delegation on
// never has an open port.

ipcMain.handle('delegation:enable', async (_e, payload: { sessionId?: string; policy?: unknown }) => {
  const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : ''
  if (!sessionId) return { ok: false, error: 'sessionId is required' }
  const raw = (payload?.policy ?? {}) as Record<string, unknown>
  try {
    const credentials = await delegationService.enable(sessionId, {
      allowFullAccess: raw.allowFullAccess === true,
      parentMode: normalizeDelegationMode(raw.parentMode),
      maxConcurrent: typeof raw.maxConcurrent === 'number' && raw.maxConcurrent > 0
        ? Math.floor(raw.maxConcurrent)
        : DEFAULT_MAX_CONCURRENT,
      remote: raw.remote === true,
    })
    return { ok: true, credentials }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'could not start delegation' }
  }
})

ipcMain.handle('delegation:disable', (_e, payload: { sessionId?: string }) => {
  if (typeof payload?.sessionId === 'string') delegationService.disable(payload.sessionId)
  return { ok: true }
})

ipcMain.handle('worktree:list', (_e, repoPath: string) => {
  const cwd = expandHome(repoPath)
  if (!existsSync(cwd)) return { worktrees: [] }

  spawnSync('git', ['worktree', 'prune'], { cwd, encoding: 'utf8' })
  const result = spawnSync('git', ['worktree', 'list', '--porcelain'], { cwd, encoding: 'utf8' })
  if (result.status !== 0) return { error: 'not a git repo' }

  return { worktrees: parsePorcelainWorktrees(result.stdout ?? '', cwd) }
})

ipcMain.handle('worktree:create', (_e, repoPath: string, branch: string, worktreePath?: string, startPoint?: string) =>
  addWorktree(repoPath, branch, { worktreePath, startPoint }))

ipcMain.handle('worktree:remove', (_e, worktreePath: string) => removeWorktree(worktreePath))

ipcMain.handle('shell:openExternal', (_e, url: string) => {
  // Only hand web/mail schemes to the OS — a renderer-supplied link must not be
  // able to invoke arbitrary protocol handlers (file://, custom app schemes).
  try {
    const { protocol: scheme } = new URL(url)
    if (!isAllowedExternalScheme(scheme)) {
      return { ok: false, error: `refused to open scheme: ${scheme}` }
    }
  } catch {
    return { ok: false, error: 'invalid url' }
  }
  shell.openExternal(url).catch(() => { /* sandbox / no browser available */ })
  return { ok: true }
})

// Hand a workspace path to VS Code. Tries the user's `code` CLI first (so
// SSH-wrapped worktrees open in their local VS Code via the configured tunnel
// or remote extension); falls back to the `vscode://file/...` URI scheme,
// which VS Code's URL handler picks up if the binary isn't on PATH.
ipcMain.handle('shell:openInEditor', (_e, dirPath: string) => {
  const target = dirPath?.trim()
  if (!target) return { ok: false, error: 'no path provided' }
  const codeCheck = spawnSync('code', ['--version'], { encoding: 'utf8' })
  if (codeCheck.status === 0) {
    try {
      const child = spawn('code', [target], { detached: true, stdio: 'ignore' })
      child.on('error', () => { /* fall through to vscode:// uri below */ })
      child.unref()
      return { ok: true, via: 'code-cli' }
    } catch (err) {
      // spawn can throw synchronously on some platforms; fall back to the URI.
    }
  }
  const encoded = target.replace(/\\/g, '/').replace(/^\//, '')
  return shell.openExternal(`vscode://file/${encoded}`)
    .then(() => ({ ok: true, via: 'vscode-uri' }))
    .catch((err: Error) => ({ ok: false, error: err.message }))
})
ipcMain.handle('clipboard:writeText', (_e, text: string) => {
  clipboard.writeText(String(text ?? ''))
  return { ok: true }
})
ipcMain.handle('clipboard:readText', () => ({ ok: true, text: clipboard.readText() }))
ipcMain.handle('clipboard:writeImageDataUrl', (_e, dataUrl: string) => {
  const image = nativeImage.createFromDataURL(dataUrl)
  if (image.isEmpty()) return { ok: false, error: 'invalid image payload' }
  clipboard.writeImage(image)
  return { ok: true }
})

// Browser grab flows run against guest webContents ids because Electron cannot
// pass <webview> instances over IPC safely.
ipcMain.handle('browser:setGrabMode', (_e, args) => browserGrabManager.setGrabMode(args))
ipcMain.handle('browser:awaitGrabSelection', (_e, args) => browserGrabManager.awaitGrabSelection(args))
ipcMain.handle('browser:cancelGrab', (_e, args) => browserGrabManager.cancelGrab(args))
ipcMain.handle('browser:captureSelectionScreenshot', (_e, args) => browserGrabManager.captureSelectionScreenshot(args))
ipcMain.handle('browser:extractHover', (_e, args) => browserGrabManager.extractHover(args))

// ─── GitHub status ────────────────────────────────────────────────────────────

ipcMain.handle('github:status', (_e, repoPath: string) => getGitHubStatus(expandHome(repoPath)))
