import { useEffect, useState } from 'react'
import { hoverTooltips, LSPClient, serverCompletion, serverDiagnostics, signatureHelp, type Transport } from '@codemirror/lsp-client'
import type { LanguageServerStatus } from '../../../../shared/language-server-types'
import { sanitizeLspHTML } from './lsp-markdown-sanitizer'
import { normalizeProblems, type EditorProblem } from './editor-lsp-features'

export type TypeScriptLanguageServerState = {
  client: LSPClient | null
  rootUri: string | null
  status: LanguageServerStatus
  error: string | null
  problems: EditorProblem[]
}

type RegistryEntry = {
  state: TypeScriptLanguageServerState
  refs: number
  listeners: Set<(state: TypeScriptLanguageServerState) => void>
  handleId: string | null
  client: LSPClient | null
  messageListeners: Set<(message: string) => void>
  removeMessage: (() => void) | null
  removeStatus: (() => void) | null
  stopTimer: number | null
  disposed: boolean
  problemsByUri: Map<string, EditorProblem[]>
}

const IDLE_DISCONNECT_MS = 30_000
const registry = new Map<string, RegistryEntry>()

export function languageServerFileUri(rootUri: string, rel: string): string {
  const base = rootUri.endsWith('/') ? rootUri : `${rootUri}/`
  return new URL(rel.split('/').map(encodeURIComponent).join('/'), base).href
}

export function languageServerRelativePath(rootUri: string, uri: string): string | null {
  try {
    const rootPath = decodeURIComponent(new URL(rootUri).pathname).replace(/\/$/, '')
    const filePath = decodeURIComponent(new URL(uri).pathname)
    const prefix = `${rootPath}/`
    if (!filePath.startsWith(prefix)) return null
    return filePath.slice(prefix.length)
  } catch {
    return null
  }
}

function publish(entry: RegistryEntry, state: TypeScriptLanguageServerState): void {
  entry.state = state
  for (const listener of entry.listeners) listener(state)
}

function disposeEntry(root: string, entry: RegistryEntry): void {
  if (entry.disposed) return
  entry.disposed = true
  if (entry.stopTimer != null) window.clearTimeout(entry.stopTimer)
  entry.removeMessage?.()
  entry.removeStatus?.()
  entry.client?.disconnect()
  if (entry.handleId) window.electronAPI?.editorLanguageServerStop(entry.handleId)
  registry.delete(root)
}

function createEntry(root: string): RegistryEntry {
  const api = window.electronAPI!
  const entry: RegistryEntry = {
    state: { client: null, rootUri: null, status: 'starting', error: null, problems: [] },
    refs: 0,
    listeners: new Set(),
    handleId: null,
    client: null,
    messageListeners: new Set(),
    removeMessage: null,
    removeStatus: null,
    stopTimer: null,
    disposed: false,
    problemsByUri: new Map(),
  }
  registry.set(root, entry)

  entry.removeMessage = api.onEditorLanguageServerMessage(event => {
    if (event.handleId !== entry.handleId) return
    for (const listener of entry.messageListeners) listener(event.message)
  })
  entry.removeStatus = api.onEditorLanguageServerStatus(event => {
    if (event.handleId !== entry.handleId || entry.disposed || event.status !== 'error') return
    publish(entry, { ...entry.state, status: 'error', error: event.error ?? 'language server failed' })
  })

  void api.editorLanguageServerStart(root).then(result => {
    if (entry.disposed) {
      if (result.handleId) api.editorLanguageServerStop(result.handleId)
      return
    }
    if (!result.ok || !result.handleId || !result.rootUri) {
      publish(entry, { client: null, rootUri: null, status: 'error', error: result.error ?? 'language server failed to start', problems: [] })
      return
    }
    entry.handleId = result.handleId
    const transport: Transport = {
      send(message) { if (entry.handleId) api.editorLanguageServerSend(entry.handleId, message) },
      subscribe(listener) { entry.messageListeners.add(listener) },
      unsubscribe(listener) { entry.messageListeners.delete(listener) },
    }
    const client = new LSPClient({
      rootUri: result.rootUri,
      timeout: 10_000,
      sanitizeHTML: sanitizeLspHTML,
      extensions: [
        {
          clientCapabilities: {
            textDocument: {
              documentSymbol: { hierarchicalDocumentSymbolSupport: true },
              codeAction: { codeActionLiteralSupport: { codeActionKind: { valueSet: ['quickfix', 'refactor', 'source'] } } },
            },
          },
          notificationHandlers: {
            'textDocument/publishDiagnostics': (_client, params: { uri?: unknown; diagnostics?: unknown }) => {
              if (typeof params.uri !== 'string') return false
              const problems = normalizeProblems(params.uri, params.diagnostics)
              if (problems.length) {
                // Keep long-lived workspaces bounded even if the server reports many files.
                if (!entry.problemsByUri.has(params.uri) && entry.problemsByUri.size >= 100) {
                  const oldestUri = entry.problemsByUri.keys().next().value
                  if (oldestUri) entry.problemsByUri.delete(oldestUri)
                }
                entry.problemsByUri.delete(params.uri)
                entry.problemsByUri.set(params.uri, problems)
              } else entry.problemsByUri.delete(params.uri)
              publish(entry, { ...entry.state, problems: [...entry.problemsByUri.values()].flat().slice(0, 2_000) })
              // Let serverDiagnostics render the same notification in CodeMirror.
              return false
            },
          },
        },
        serverCompletion(),
        hoverTooltips(),
        signatureHelp(),
        serverDiagnostics(),
      ],
    }).connect(transport)
    entry.client = client
    client.initializing.then(() => {
      if (!entry.disposed) publish(entry, { client, rootUri: result.rootUri!, status: 'ready', error: null, problems: entry.state.problems })
    }).catch(error => {
      if (!entry.disposed) publish(entry, { client: null, rootUri: result.rootUri!, status: 'error', error: error instanceof Error ? error.message : String(error), problems: entry.state.problems })
    })
  }).catch(error => {
    if (!entry.disposed) publish(entry, { client: null, rootUri: null, status: 'error', error: error instanceof Error ? error.message : String(error), problems: [] })
  })

  return entry
}

export function useTypeScriptLanguageServer(root?: string): TypeScriptLanguageServerState {
  const [state, setState] = useState<TypeScriptLanguageServerState>({ client: null, rootUri: null, status: 'stopped', error: null, problems: [] })

  useEffect(() => {
    if (!root || !window.electronAPI?.editorLanguageServerStart) {
      setState({ client: null, rootUri: null, status: 'stopped', error: null, problems: [] })
      return
    }
    const entry = registry.get(root) ?? createEntry(root)
    if (entry.stopTimer != null) {
      window.clearTimeout(entry.stopTimer)
      entry.stopTimer = null
    }
    entry.refs++
    entry.listeners.add(setState)
    setState(entry.state)

    return () => {
      entry.listeners.delete(setState)
      entry.refs--
      if (entry.refs === 0) entry.stopTimer = window.setTimeout(() => disposeEntry(root, entry), IDLE_DISCONNECT_MS)
    }
  }, [root])

  return state
}
