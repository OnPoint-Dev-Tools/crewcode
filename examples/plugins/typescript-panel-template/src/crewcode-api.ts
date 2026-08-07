// Official CrewCode plugin API. GENERATED from crewcode-plugin-api/src — do not edit by hand.
// Vendored so this template builds with no external dependency.
// If you prefer a managed dependency: npm install crewcode-plugin-api

export const CREWCODE_PLUGIN_API_VERSION = '0.1' as const

export type CrewCodePluginApiVersion = typeof CREWCODE_PLUGIN_API_VERSION

export interface CrewCodeWorkspaceContext {
  id: string
  name: string
  kind: string
}

export interface CrewCodePluginOpenContext {
  source: string
  filePath?: string
  browserUrl?: string
  terminalPaneId?: string
  chatMessageId?: string
}

export interface CrewCodePluginContext {
  type: 'crewcode:context'
  /**
   * The plugin API version of the running CrewCode host. Use it to feature-detect
   * at runtime, e.g. `if (ctx.hostApiVersion !== crewcode.apiVersion) { ... }`.
   * Optional for backward compatibility with hosts that predate this field.
   */
  hostApiVersion?: string
  pluginId: string
  registrationId: string
  workspace: CrewCodeWorkspaceContext | null
  permissions: string[]
  openContext: CrewCodePluginOpenContext
}

export interface WorkspaceFileList {
  files: string[]
}

export interface WorkspaceReadFileResult {
  rel: string
  text: string
  size: number
}

export interface WorkspaceWriteFileResult {
  rel: string
}

export interface CrewCodeWorkspaceApi {
  listFiles(): Promise<WorkspaceFileList>
  readFile(sub: string): Promise<WorkspaceReadFileResult>
  writeFile(sub: string, text: string): Promise<WorkspaceWriteFileResult>
}

export interface CrewCodeNetworkApi {
  fetch(input: string, init?: Record<string, unknown>): Promise<never>
}

export interface CrewCodeSecretsApi {
  get(key: string): Promise<never>
}

export interface CrewCodePluginApi {
  apiVersion: CrewCodePluginApiVersion
  request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>
  onContext(listener: (ctx: CrewCodePluginContext) => void): () => void
  getContext(): CrewCodePluginContext | null
  workspace: CrewCodeWorkspaceApi
  network: CrewCodeNetworkApi
  secrets: CrewCodeSecretsApi
}

interface PendingRequest<T = unknown> {
  resolve: (value: T) => void
  reject: (err: Error) => void
}

export interface CreateCrewCodeApiOptions {
  /** Milliseconds before an unanswered request rejects. Default 10000. */
  timeoutMs?: number
  /** postMessage targetOrigin. Default '*'. */
  targetOrigin?: string
}

// Reserved v0 namespaces: these are declared for forward-compat but the host
// gate denies them from iframes today. Reject early with an actionable message
// instead of round-tripping to the host only to fail there.
const RESERVED_NETWORK_MESSAGE =
  'crewcode.network.fetch is reserved in plugin API v0. Use an agentProvider runtime (http/sse-http/openai-compatible/websocket) for network access.'
const RESERVED_SECRETS_MESSAGE =
  'crewcode.secrets.get is reserved in plugin API v0. Use a provider apiKeyEnv or local CLI auth instead.'

export function createCrewCodeApi(options: CreateCrewCodeApiOptions = {}): CrewCodePluginApi {
  const timeoutMs = options.timeoutMs ?? 10_000
  const targetOrigin = options.targetOrigin ?? '*'
  const pending = new Map<string, PendingRequest>()
  const contextListeners = new Set<(ctx: CrewCodePluginContext) => void>()
  let seq = 0
  let latestContext: CrewCodePluginContext | null = null

  const reportError = (err: unknown) => {
    const error = err instanceof Error ? err : new Error(String(err))
    window.parent.postMessage({ type: 'crewcode:runtimeError', message: error.message, stack: error.stack }, targetOrigin)
  }

  window.addEventListener('error', event => reportError(event.error ?? event.message))
  window.addEventListener('unhandledrejection', event => reportError(event.reason))

  const request = <T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> => {
    const id = `req-${++seq}`
    window.parent.postMessage({ type: 'crewcode:request', id, method, params }, targetOrigin)
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
      window.setTimeout(() => {
        if (!pending.has(id)) return
        pending.delete(id)
        reject(new Error('CrewCode plugin request timed out'))
      }, timeoutMs)
    })
  }

  window.addEventListener('message', event => {
    // Only trust messages from the embedding CrewCode renderer, never sibling
    // frames or nested content injected into the panel.
    if (event.source !== window.parent) return

    const msg = event.data as Record<string, unknown> | null
    if (!msg || typeof msg !== 'object') return

    if (msg.type === 'crewcode:context') {
      latestContext = msg as unknown as CrewCodePluginContext
      for (const listener of contextListeners) listener(latestContext)
      return
    }

    if (msg.type === 'crewcode:response' && typeof msg.id === 'string' && pending.has(msg.id)) {
      const callbacks = pending.get(msg.id)!
      pending.delete(msg.id)
      if (msg.ok) callbacks.resolve(msg.result)
      else callbacks.reject(new Error(typeof msg.error === 'string' ? msg.error : 'plugin request failed'))
    }
  })

  return {
    apiVersion: CREWCODE_PLUGIN_API_VERSION,
    request,
    onContext(listener) {
      contextListeners.add(listener)
      if (latestContext) listener(latestContext)
      return () => contextListeners.delete(listener)
    },
    getContext: () => latestContext,
    workspace: {
      listFiles: () => request<WorkspaceFileList>('workspace:listFiles'),
      readFile: sub => request<WorkspaceReadFileResult>('workspace:readFile', { sub }),
      writeFile: (sub, text) => request<WorkspaceWriteFileResult>('workspace:writeFile', { sub, text }),
    },
    network: {
      fetch: () => Promise.reject(new Error(RESERVED_NETWORK_MESSAGE)),
    },
    secrets: {
      get: () => Promise.reject(new Error(RESERVED_SECRETS_MESSAGE)),
    },
  }
}

export const crewcode = createCrewCodeApi()
