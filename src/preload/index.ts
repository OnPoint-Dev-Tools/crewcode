import { contextBridge, ipcRenderer, webFrame } from 'electron'
import type {
  BrowserAwaitGrabSelectionArgs,
  BrowserCancelGrabArgs,
  BrowserCaptureSelectionScreenshotArgs,
  BrowserExtractHoverArgs,
  BrowserSetGrabModeArgs,
} from '../shared/browser-grab-types'
import type { McpServerConfig } from '../shared/mcp-types'
import type { RateLimitState } from '../shared/rate-limit-types'
import type { AgentCompletionRequest } from '../shared/agent-completion-types'
import type { LanguageServerMessageEvent, LanguageServerStartResult, LanguageServerStatusEvent } from '../shared/language-server-types'
import type { WriterBinaryFormat } from '../shared/writer-document-types'
import type {
  LocalVoiceStartRequest,
  LocalVoiceWarmupCapability,
  RemoteVoiceProviderId,
  VoiceClientSecretRequest,
  VoiceSpeechRequest,
  VoiceTranscriptionRequest,
} from '../shared/voice-types'

// Single `pty:data` listener that fans out to per-pane handlers. Replaces the
// old pattern of one global listener per terminal pane (each running for every
// pane's output). A Set per pane tolerates React StrictMode's transient double
// subscribe without dropping the survivor on the first cleanup.
const ptyDataRouter = (() => {
  const handlers = new Map<string, Set<(data: string) => void>>()
  let wired = false
  const ensureWired = (): void => {
    if (wired) return
    wired = true
    ipcRenderer.on('pty:data', (_e, payload: { paneId: string; data: string }) => {
      const set = handlers.get(payload.paneId)
      if (!set) return
      for (const cb of set) cb(payload.data)
    })
  }
  return {
    add(paneId: string, cb: (data: string) => void): void {
      ensureWired()
      let set = handlers.get(paneId)
      if (!set) { set = new Set(); handlers.set(paneId, set) }
      set.add(cb)
    },
    remove(paneId: string, cb: (data: string) => void): void {
      const set = handlers.get(paneId)
      if (!set) return
      set.delete(cb)
      if (set.size === 0) handlers.delete(paneId)
    },
  }
})()

contextBridge.exposeInMainWorld('electronAPI', {
  // Window controls
  minimize: () => ipcRenderer.send('win:minimize'),
  maximize: () => ipcRenderer.send('win:maximize'),
  close:    () => ipcRenderer.send('win:close'),
  // Native Chromium page zoom, matching VS Code/Electron behavior. Unlike CSS
  // `zoom`, this updates the web contents viewport and relayouts the app.
  setUiZoom: (percent: number): void =>
    webFrame.setZoomFactor(Math.min(1.5, Math.max(0.75, percent / 100))),

  // Agent registry — detect installed CLI tools
  agentRegistry:   () => ipcRenderer.invoke('agent:registry'),
  agentListModels: (provider: string) => ipcRenderer.invoke('agent:listModels', provider),
  agentSetPath:    (id: string, path: string | null) => ipcRenderer.invoke('agent:setPath', id, path),
  agentGetKey:     (id: string) => ipcRenderer.invoke('agent:getKey', id),
  agentSetKey:     (id: string, key: string | null) => ipcRenderer.invoke('agent:setKey', id, key),
  agentCompletion: (request: AgentCompletionRequest) => ipcRenderer.invoke('agent:completion', request),
  agentCompletionCancel: (requestId: string): void => ipcRenderer.send('agent:completionCancel', requestId),

  // ─── Realtime voice ────────────────────────────────────────────
  voiceProviderAvailability: () => ipcRenderer.invoke('voice:providerAvailability'),
  voiceSetProviderKey: (provider: RemoteVoiceProviderId, key: string | null) =>
    ipcRenderer.invoke('voice:setProviderKey', provider, key),
  voiceCreateClientSecret: (request: VoiceClientSecretRequest) =>
    ipcRenderer.invoke('voice:createClientSecret', request),
  voiceTranscribe: (request: VoiceTranscriptionRequest) =>
    ipcRenderer.invoke('voice:transcribe', request),
  voiceSynthesize: (request: VoiceSpeechRequest) =>
    ipcRenderer.invoke('voice:synthesize', request),
  voiceLocalStart: (request: LocalVoiceStartRequest) => ipcRenderer.invoke('voice:localStart', request),
  voiceLocalPrewarm: (request: LocalVoiceStartRequest, capability: LocalVoiceWarmupCapability) =>
    ipcRenderer.invoke('voice:localPrewarm', request, capability),
  voiceLocalStatus: () => ipcRenderer.invoke('voice:localStatus'),
  voiceLocalTranscribe: (audio: Uint8Array) => ipcRenderer.invoke('voice:localTranscribe', audio),
  voiceLocalSynthesize: (text: string, voice: string, speed?: number) =>
    ipcRenderer.invoke('voice:localSynthesize', text, voice, speed),

  // ─── Shell detection ──────────────────────────────────────────
  shellsDetect: () => ipcRenderer.invoke('shells:detect'),

  // ─── PTY lifecycle ─────────────────────────────────────────────
  // ptyCreate also acts as reattach when paneId already has a live process.
  ptyCreate: (opts: {
    paneId: string
    cwd?:   string
    cols?:  number
    rows?:  number
    shell?: string
    argv?:  string[]
    env?:   Record<string, string>
  }) => ipcRenderer.invoke('pty:create', opts),

  ptyWrite: (paneId: string, data: string): void =>
    ipcRenderer.send('pty:write', { paneId, data }),

  ptyResize: (paneId: string, cols: number, rows: number): void =>
    ipcRenderer.send('pty:resize', { paneId, cols, rows }),

  ptyKill: (paneId: string): void =>
    ipcRenderer.send('pty:kill', paneId),

  onPtyData: (cb: (data: { paneId: string; data: string }) => void) => {
    const listener = (_e: unknown, payload: { paneId: string; data: string }) => cb(payload)
    ipcRenderer.on('pty:data', listener)
    return () => ipcRenderer.removeListener('pty:data', listener)
  },

  // Per-pane pty output routing. Every terminal pane used to register its own
  // global `pty:data` listener and filter by paneId, so one chunk from any pane
  // fired N callbacks (N-1 no-ops) across N mounted terminals. This keeps a
  // single shared listener that dispatches O(1) to the owning pane's handler —
  // the difference between smooth and janky when several agent terminals stream
  // at once.
  onPtyDataForPane: (paneId: string, cb: (data: string) => void) => {
    ptyDataRouter.add(paneId, cb)
    return () => ptyDataRouter.remove(paneId, cb)
  },

  onPtyExit: (cb: (data: { paneId: string; exitCode: number; signal?: number }) => void) => {
    const listener = (_e: unknown, payload: { paneId: string; exitCode: number; signal?: number }) => cb(payload)
    ipcRenderer.on('pty:exit', listener)
    return () => ipcRenderer.removeListener('pty:exit', listener)
  },

  // ─── Agent bridge (structured streaming for bridge providers) ──────
  bridgeStart: (opts: {
    bridgeId:    string
    provider:    'pi' | 'opencode' | 'codex' | 'claude' | 'hermes' | 'crewcoder' | 'grok' | 'ollama' | 'openrouter' | `plugin:${string}`
    cwd:         string
    externalDirectories?: string[]
    model?:      string
    mode?:       'ask' | 'plan' | 'build' | 'full'
    toolPolicy?: 'default' | 'read-only'
    thinking?:   'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra'
    apiKey?:     string
    env?:        Record<string, string>
    sessionKey?: string                    // "tabId:agentId" — used to look up the resume id
    conversationScopeKey?: string          // chat session id — shared local context across providers
    freshSession?: boolean                 // handoff starts fresh and seeds from summary
    mcpServers?: McpServerConfig[]         // session-selected MCP servers to attach
  }) => ipcRenderer.invoke('bridge:start', opts),

  bridgePrompt: (bridgeId: string, text: string, options?: {
    streamingBehavior?: 'followUp'
    handoff?: {
      fromProvider?: string
      toProvider?: string
      model?: string
      mode?: 'ask' | 'plan' | 'build' | 'full'
      workspace?: { name?: string; path?: string; branch?: string }
    }
  }) => ipcRenderer.invoke('bridge:prompt', { bridgeId, text, options }),

  bridgeCompact: (bridgeId: string) =>
    ipcRenderer.invoke('bridge:compact', { bridgeId }),

  bridgeHandoff: (bridgeId: string, sourceConversationKey: string, options: {
    fromProvider?: string
    toProvider?: string
    model?: string
    mode?: 'ask' | 'plan' | 'build' | 'full'
    workspace?: { name?: string; path?: string; branch?: string }
  }) => ipcRenderer.invoke('bridge:handoff', { bridgeId, sourceConversationKey, options }),

  // Cancel a locally queued follow-up (claude) before the bridge sends it.
  bridgeRemoveFollowUp: (bridgeId: string, followUpId: string) =>
    ipcRenderer.invoke('bridge:removeFollowUp', { bridgeId, followUpId }),

  bridgeRespondUserRequest: (response: {
    requestId: string
    action: 'accept' | 'accept_for_turn' | 'decline' | 'submit' | 'cancel'
    value?: string
    optionId?: string
  }) => ipcRenderer.invoke('bridge:respondUserRequest', response),

  bridgeSetMode: (bridgeId: string, mode: 'ask' | 'plan' | 'build' | 'full'): void =>
    ipcRenderer.send('bridge:setMode', { bridgeId, mode }),

  // Execution custody: explicit human reauthorization after an invariant
  // tripped, and the read-only state behind the halt banner.
  bridgeReauthorize: (args: { bridgeId?: string; scopeKey?: string }) =>
    ipcRenderer.invoke('bridge:reauthorize', args),

  bridgeCustodyState: (args: { sessionKey?: string | null; bridgeId?: string }) =>
    ipcRenderer.invoke('bridge:custodyState', args),

  bridgeAbort: (bridgeId: string): void =>
    ipcRenderer.send('bridge:abort', bridgeId),

  bridgeStop: (bridgeId: string): void =>
    ipcRenderer.send('bridge:stop', bridgeId),

  // Forget the persisted resume id for this composite key so the next
  // bridge:start opens a fresh upstream session. Caller is responsible for
  // bridgeStop'ing any live bridge first.
  bridgeResetSession: (sessionKey: string, conversationScopeKey?: string) =>
    ipcRenderer.invoke('bridge:resetSession', { sessionKey, conversationScopeKey }),

  onBridgeEvent: (cb: (event: unknown) => void) => {
    const listener = (_e: unknown, event: unknown) => cb(event)
    ipcRenderer.on('bridge:event', listener)
    return () => ipcRenderer.removeListener('bridge:event', listener)
  },

  // ─── Delegation ────────────────────────────────────────────────
  // Main marshals delegation API calls in; the renderer answers by correlation
  // id. The renderer never talks to the loopback HTTP surface directly.
  onDelegationRequest: (cb: (request: unknown) => void) => {
    const listener = (_e: unknown, request: unknown) => cb(request)
    ipcRenderer.on('delegation:request', listener)
    return () => ipcRenderer.removeListener('delegation:request', listener)
  },

  delegationRespond: (id: string, result: unknown): void =>
    ipcRenderer.send('delegation:response', { id, result }),

  // Mints this session's credentials (and starts the loopback server on first
  // use). The token is generated in main; the renderer only forwards it into the
  // agent's context.
  delegationEnable: (sessionId: string, policy: {
    allowFullAccess: boolean
    parentMode: 'ask' | 'plan' | 'build' | 'full'
    maxConcurrent: number
    remote: boolean
  }) => ipcRenderer.invoke('delegation:enable', { sessionId, policy }),

  delegationDisable: (sessionId: string) =>
    ipcRenderer.invoke('delegation:disable', { sessionId }),

  // ─── Workspaces ────────────────────────────────────────────────
  workspacesList:       () => ipcRenderer.invoke('workspaces:list'),
  workspacesAdd:        (path: string) => ipcRenderer.invoke('workspaces:add', path),
  workspacesRemove:     (id: string)   => ipcRenderer.invoke('workspaces:remove', id),
  workspacesPin:        (id: string, pinned: boolean) => ipcRenderer.invoke('workspaces:pin', id, pinned),
  workspacesRename:     (id: string, name: string)    => ipcRenderer.invoke('workspaces:rename', id, name),
  workspacesSetFolder:  (id: string, folder: string | null) => ipcRenderer.invoke('workspaces:setFolder', id, folder),
  workspacesPickFolder: () => ipcRenderer.invoke('workspaces:pickFolder'),
  pickExternalDirectory: () => ipcRenderer.invoke('directories:pickExternal'),
  workspacesCloneRepo:   (url: string, parentDir: string, folderName?: string) =>
    ipcRenderer.invoke('workspaces:cloneRepo', url, parentDir, folderName),
  workspacesInitProject: (parentDir: string, folderName: string, asGit: boolean) =>
    ipcRenderer.invoke('workspaces:initProject', parentDir, folderName, asGit),
  workspacesAddRemote:   (opts: { host: string; user?: string; port?: number; path: string; name?: string }) =>
    ipcRenderer.invoke('workspaces:addRemote', opts),

  // ─── Chat transcripts (authoritative on-disk store) ───────────
  transcriptsLoadAll: () => ipcRenderer.invoke('transcripts:loadAll'),
  transcriptsMtimes:  () => ipcRenderer.invoke('transcripts:mtimes'),
  transcriptsSave:    (scopeId: string, messages: unknown[]) => ipcRenderer.invoke('transcripts:save', scopeId, messages),
  transcriptsRemove:  (scopeId: string) => ipcRenderer.invoke('transcripts:remove', scopeId),
  // Synchronous batch — used only on window teardown so the last turn can't be
  // dropped by an async invoke that never lands before the renderer dies.
  transcriptsSaveSyncBatch: (entries: { scopeId: string; messages: unknown[] }[]): boolean =>
    ipcRenderer.sendSync('transcripts:saveSyncBatch', entries),

  // ─── Filesystem (sandboxed under workspace root) ──────────────
  fsReadDir:   (root: string, sub?: string)               => ipcRenderer.invoke('fs:readDir',   root, sub ?? ''),
  fsListFiles: (root: string)                             => ipcRenderer.invoke('fs:listFiles', root),
  fsReadFile:  (root: string, sub: string)                => ipcRenderer.invoke('fs:readFile',  root, sub),
  fsReadDataUrl: (root: string, sub: string)              => ipcRenderer.invoke('fs:readDataUrl', root, sub),
  fsWriteFile: (root: string, sub: string, text: string)  => ipcRenderer.invoke('fs:writeFile', root, sub, text),
  fsMkdir:     (root: string, sub: string)                => ipcRenderer.invoke('fs:mkdir',     root, sub),
  fsFormat:    (root: string, sub: string, text: string)  => ipcRenderer.invoke('fs:format',    root, sub, text),
  fsDelete:    (root: string, sub: string)                    => ipcRenderer.invoke('fs:delete',   root, sub),
  fsRename:    (root: string, sub: string, newName: string)   => ipcRenderer.invoke('fs:rename',  root, sub, newName),
  fsCopyFile:  (root: string, sub: string)                    => ipcRenderer.invoke('fs:copyFile', root, sub),
  fsMove:      (root: string, srcRel: string, destDirRel: string) => ipcRenderer.invoke('fs:move', root, srcRel, destDirRel),

  // Writer binary formats are converted in main; renderer never receives raw
  // filesystem access outside the existing workspace sandbox.
  writerDocumentsImport: (root: string, sourceRel: string) =>
    ipcRenderer.invoke('writerDocuments:import', root, sourceRel),
  writerDocumentsExport: (root: string, sourceRel: string, markdown: string, format: WriterBinaryFormat) =>
    ipcRenderer.invoke('writerDocuments:export', root, sourceRel, markdown, format),

  // ─── Editor live-reload: watch open files for on-disk changes ──
  editorWatchAdd:    (root: string, rel: string): void => ipcRenderer.send('editorWatch:add', root, rel),
  editorWatchRemove: (root: string, rel: string): void => ipcRenderer.send('editorWatch:remove', root, rel),
  onEditorFileChanged: (cb: (event: { root: string; rel: string }) => void) => {
    const listener = (_e: unknown, event: { root: string; rel: string }) => cb(event)
    ipcRenderer.on('editor:fileChanged', listener)
    return () => ipcRenderer.removeListener('editor:fileChanged', listener)
  },

  // ─── TypeScript/JavaScript language server ────────────────────
  editorLanguageServerStart: (root: string): Promise<LanguageServerStartResult> =>
    ipcRenderer.invoke('editorLanguageServer:start', root),
  editorLanguageServerSend: (handleId: string, message: string): void =>
    ipcRenderer.send('editorLanguageServer:send', handleId, message),
  editorLanguageServerStop: (handleId: string): void =>
    ipcRenderer.send('editorLanguageServer:stop', handleId),
  onEditorLanguageServerMessage: (cb: (event: LanguageServerMessageEvent) => void) => {
    const listener = (_e: unknown, event: LanguageServerMessageEvent) => cb(event)
    ipcRenderer.on('editorLanguageServer:message', listener)
    return () => ipcRenderer.removeListener('editorLanguageServer:message', listener)
  },
  onEditorLanguageServerStatus: (cb: (event: LanguageServerStatusEvent) => void) => {
    const listener = (_e: unknown, event: LanguageServerStatusEvent) => cb(event)
    ipcRenderer.on('editorLanguageServer:status', listener)
    return () => ipcRenderer.removeListener('editorLanguageServer:status', listener)
  },

  // ─── File attachments (drag/drop, paste, paperclip picker) ─────
  // `import` takes raw bytes (File.arrayBuffer() / paste DataTransferItem) and
  // copies them into <root>/.crewcode/attachments/, returning rel paths.
  attachmentsPick: () =>
    ipcRenderer.invoke('attachments:pick'),
  attachmentsImport: (root: string, items: Array<{ name: string; data: ArrayBuffer | Uint8Array }>) =>
    ipcRenderer.invoke('attachments:import', root, items),

  // ─── Git worktree management ───────────────────────────────────
  worktreeList:   (repoPath: string) =>
    ipcRenderer.invoke('worktree:list', repoPath),
  worktreeCreate: (repoPath: string, branch: string, worktreePath?: string, startPoint?: string) =>
    ipcRenderer.invoke('worktree:create', repoPath, branch, worktreePath, startPoint),
  worktreeRemove: (worktreePath: string) =>
    ipcRenderer.invoke('worktree:remove', worktreePath),

  // ─── Shell ────────────────────────────────────────────────────
  openExternal: (url: string) =>
    ipcRenderer.invoke('shell:openExternal', url),
  openInEditor: (path: string) =>
    ipcRenderer.invoke('shell:openInEditor', path),

  // ─── Keybindings (~/.crewcode/keys.json) ──────────────────────
  keybindsRead:  () =>
    ipcRenderer.invoke('keybinds:read'),
  keybindsWrite: (data: Record<string, string[]>) =>
    ipcRenderer.invoke('keybinds:write', data),
  keybindsOpen:  (seed: Record<string, string[]>) =>
    ipcRenderer.invoke('keybinds:open', seed),
  onKeybindsChanged: (cb: (event: { ok: boolean; data?: Record<string, string[]> | null }) => void) => {
    const listener = (_e: unknown, event: { ok: boolean; data?: Record<string, string[]> | null }) => cb(event)
    ipcRenderer.on('keybinds:changed', listener)
    return () => ipcRenderer.removeListener('keybinds:changed', listener)
  },

  // ─── Native OS notifications (agent turn-complete pings) ──────
  notify: (payload: { title: string; body: string; scopeId?: string; silent?: boolean }) =>
    ipcRenderer.invoke('notify:show', payload),
  onNotificationClick: (cb: (event: { scopeId: string }) => void) => {
    const listener = (_e: unknown, event: { scopeId: string }) => cb(event)
    ipcRenderer.on('notify:click', listener)
    return () => ipcRenderer.removeListener('notify:click', listener)
  },

  // ─── YuHeard terminal agent alerts ────────────────────────────
  // Server pushes state transitions; renderer plays sound + optional
  // OS notify. The socket path is exposed so settings can show it.
  yuheardStatus: () =>
    ipcRenderer.invoke('yuheard:status') as Promise<{ socket: string | null; running: boolean }>,
  onYuheardState: (cb: (event: { paneId: string; state: 'running' | 'complete'; message: string | null; source: string; at: number }) => void) => {
    const listener = (_e: unknown, event: { paneId: string; state: 'running' | 'complete'; message: string | null; source: string; at: number }) => cb(event)
    ipcRenderer.on('yuheard:state', listener)
    return () => ipcRenderer.removeListener('yuheard:state', listener)
  },

  clipboardWriteText: (text: string) =>
    ipcRenderer.invoke('clipboard:writeText', text),
  clipboardReadText: () =>
    ipcRenderer.invoke('clipboard:readText'),
  clipboardWriteImageDataUrl: (dataUrl: string) =>
    ipcRenderer.invoke('clipboard:writeImageDataUrl', dataUrl),

  // ─── Browser tools ────────────────────────────────────────────
  browserSetGrabMode: (args: BrowserSetGrabModeArgs) =>
    ipcRenderer.invoke('browser:setGrabMode', args),
  browserAwaitGrabSelection: (args: BrowserAwaitGrabSelectionArgs) =>
    ipcRenderer.invoke('browser:awaitGrabSelection', args),
  browserCancelGrab: (args: BrowserCancelGrabArgs) =>
    ipcRenderer.invoke('browser:cancelGrab', args),
  browserCaptureSelectionScreenshot: (args: BrowserCaptureSelectionScreenshotArgs) =>
    ipcRenderer.invoke('browser:captureSelectionScreenshot', args),
  browserExtractHover: (args: BrowserExtractHoverArgs) =>
    ipcRenderer.invoke('browser:extractHover', args),

  // ─── GitHub status (requires gh CLI) ──────────────────────────
  githubStatus: (repoPath: string) =>
    ipcRenderer.invoke('github:status', repoPath),

  // ─── Git (status, staging, commit, push, pull, etc.) ──────────
  gitStatus:   (cwd: string) =>
    ipcRenderer.invoke('git:status', cwd),
  gitStage:    (cwd: string, paths: string[]) =>
    ipcRenderer.invoke('git:stage', cwd, paths),
  gitStageAll: (cwd: string) =>
    ipcRenderer.invoke('git:stageAll', cwd),
  gitUnstage:  (cwd: string, paths: string[]) =>
    ipcRenderer.invoke('git:unstage', cwd, paths),
  gitDiff:     (cwd: string, path: string, staged: boolean) =>
    ipcRenderer.invoke('git:diff', cwd, path, staged),
  gitChangesVsRef: (cwd: string, ref: string) =>
    ipcRenderer.invoke('git:changesVsRef', cwd, ref),
  gitDiffVsRef: (cwd: string, ref: string, path: string) =>
    ipcRenderer.invoke('git:diffVsRef', cwd, ref, path),
  gitCommit:   (cwd: string, message: string, amend?: boolean, noSign?: boolean) =>
    ipcRenderer.invoke('git:commit', cwd, message, amend, noSign),
  gitCommitWithPassphrase: (cwd: string, message: string, amend: boolean | undefined, passphrase: string) =>
    ipcRenderer.invoke('git:commitWithPassphrase', cwd, message, amend, passphrase),
  gitPush:     (cwd: string) =>
    ipcRenderer.invoke('git:push', cwd),
  gitPushWithCredentials: (cwd: string, username: string, password: string) =>
    ipcRenderer.invoke('git:pushWithCredentials', cwd, username, password),
  gitPull:     (cwd: string) =>
    ipcRenderer.invoke('git:pull', cwd),
  gitFetch:    (cwd: string) =>
    ipcRenderer.invoke('git:fetch', cwd),
  gitLog:      (cwd: string, limit?: number) =>
    ipcRenderer.invoke('git:log', cwd, limit ?? 20),
  gitBranches: (cwd: string) =>
    ipcRenderer.invoke('git:branches', cwd),
  gitCheckout: (cwd: string, branch: string) =>
    ipcRenderer.invoke('git:checkout', cwd, branch),
  gitCreateBranch: (cwd: string, name: string) =>
    ipcRenderer.invoke('git:createBranch', cwd, name),
  gitMerge: (cwd: string, ref: string) =>
    ipcRenderer.invoke('git:merge', cwd, ref),
  gitSuggestedCrewChecks: (cwd: string) =>
    ipcRenderer.invoke('git:suggestedCrewChecks', cwd),
  gitRunSuggestedCrewCheck: (cwd: string, id: string) =>
    ipcRenderer.invoke('git:runSuggestedCrewCheck', cwd, id),
  gitCrewIntegrationStatus: (sessionId: string) =>
    ipcRenderer.invoke('git:crewIntegrationStatus', sessionId),
  gitVerifyCrewIntegration: (request: unknown) =>
    ipcRenderer.invoke('git:verifyCrewIntegration', request),
  gitApplyCrewIntegration: (sessionId: string) =>
    ipcRenderer.invoke('git:applyCrewIntegration', sessionId),
  gitMergeDelegated: (request: { worktreePath: string; repoPath: string; branch: string; base: string }) =>
    ipcRenderer.invoke('git:mergeDelegated', request),
  gitDiffDelegated: (worktreePath: string, base: string, branch: string) =>
    ipcRenderer.invoke('git:diffDelegated', worktreePath, base, branch),
  gitMergeAbort: (cwd: string) =>
    ipcRenderer.invoke('git:mergeAbort', cwd),
  gitMergeContinue: (cwd: string) =>
    ipcRenderer.invoke('git:mergeContinue', cwd),
  gitResolveConflict: (cwd: string, file: string, strategy: string) =>
    ipcRenderer.invoke('git:resolveConflict', cwd, file, strategy),
  gitRemotes:  (cwd: string) =>
    ipcRenderer.invoke('git:remotes', cwd),
  gitInit:     (cwd: string) =>
    ipcRenderer.invoke('git:init', cwd),

  // ─── Auto-updater ──────────────────────────────────────────────
  appBuildInfo:           () => ipcRenderer.invoke('app:buildInfo'),
  appHomePath:            () => ipcRenderer.invoke('app:homePath'),
  updaterCheck:           () => ipcRenderer.invoke('updater:check'),
  updaterDownload:        () => ipcRenderer.invoke('updater:download'),
  updaterQuitAndInstall:  () => ipcRenderer.invoke('updater:quitAndInstall'),
  updaterConfigure:       (config: { channel: string; autoDownload: boolean }) =>
    ipcRenderer.invoke('updater:configure', config),
  onUpdaterEvent: (cb: (event: unknown) => void) => {
    const listener = (_e: unknown, event: unknown) => cb(event)
    ipcRenderer.on('updater:event', listener)
    return () => ipcRenderer.removeListener('updater:event', listener)
  },

  // ─── gh CLI auth ──────────────────────────────────────────────
  ghStatus:       () => ipcRenderer.invoke('gh:status'),
  ghLoginStart:   () => ipcRenderer.invoke('gh:loginStart'),
  ghLoginCancel:  () => ipcRenderer.invoke('gh:loginCancel'),
  ghLogout:       () => ipcRenderer.invoke('gh:logout'),
  ghPrCreate:     (cwd: string) => ipcRenderer.invoke('gh:prCreate', cwd),
  ghPrMerge:      (cwd: string, num: number) => ipcRenderer.invoke('gh:prMerge', cwd, num),
  ghPrApprove:    (cwd: string, num: number) => ipcRenderer.invoke('gh:prApprove', cwd, num),
  ghRepoCreate:   (cwd: string, opts: { name: string; visibility: 'private' | 'public'; description?: string }) =>
    ipcRenderer.invoke('gh:repoCreate', cwd, opts),
  onGhAuthEvent: (cb: (event: unknown) => void) => {
    const listener = (_e: unknown, event: unknown) => cb(event)
    ipcRenderer.on('gh:authEvent', listener)
    return () => ipcRenderer.removeListener('gh:authEvent', listener)
  },

  // ─── SSH config + keys ────────────────────────────────────────
  sshListConfig: () => ipcRenderer.invoke('ssh:listConfig'),
  sshListKeys:   () => ipcRenderer.invoke('ssh:listKeys'),
  sshAddKey:     (path: string, passphrase?: string) => ipcRenderer.invoke('ssh:addKey', path, passphrase),
  sshRemoveKey:  (path: string) => ipcRenderer.invoke('ssh:removeKey', path),
  sshOpenConfig: () => ipcRenderer.invoke('ssh:openConfig'),
  sshTest:       (target: string) => ipcRenderer.invoke('ssh:test', target),

  // ─── Remote (SSH) workspaces: directory browsing + connection state ───
  sshRemoteHome:    (spec: { host: string; user?: string; port?: number }) =>
    ipcRenderer.invoke('ssh:remoteHome', spec),
  sshListRemoteDir: (spec: { host: string; user?: string; port?: number }, path: string) =>
    ipcRenderer.invoke('ssh:listRemoteDir', spec, path),
  sshConnectRemote: (spec: { host: string; user?: string; port?: number }, path: string) =>
    ipcRenderer.invoke('ssh:connectRemote', spec, path),
  sshDisconnectRemote: (connId: string) =>
    ipcRenderer.invoke('ssh:disconnectRemote', connId),
  onRemoteStatus: (cb: (event: { connId: string; status: string; error: string | null }) => void) => {
    const listener = (_e: unknown, event: { connId: string; status: string; error: string | null }) => cb(event)
    ipcRenderer.on('remote:status', listener)
    return () => ipcRenderer.removeListener('remote:status', listener)
  },

  // ─── Custom slash-commands / home CrewCode config ─────────────
  crewcodeConfigDir: () => ipcRenderer.invoke('crewcode:configDir'),
  commandsOpenDir:   () => ipcRenderer.invoke('commands:openDir'),

  // ─── MCP file registry (~/.crewcode/mcp.json) ─────────────────
  mcpList:     () => ipcRenderer.invoke('mcp:list'),
  mcpOpenFile: () => ipcRenderer.invoke('mcp:openFile'),
  onMcpChanged: (cb: (event: unknown) => void) => {
    const listener = (_e: unknown, event: unknown) => cb(event)
    ipcRenderer.on('mcp:changed', listener)
    return () => ipcRenderer.removeListener('mcp:changed', listener)
  },

  // ─── Local plugins ────────────────────────────────────────────
  pluginsList:       () => ipcRenderer.invoke('plugins:list'),
  pluginsWatch:      () => ipcRenderer.invoke('plugins:watch'),
  pluginsRefresh:    () => ipcRenderer.invoke('plugins:refresh'),
  pluginsCopyExample:(exampleId?: string) => ipcRenderer.invoke('plugins:copyExample', exampleId),
  pluginsInspectGit: (request: unknown) => ipcRenderer.invoke('plugins:inspectGit', request),
  pluginsInstallGit: (token: string) => ipcRenderer.invoke('plugins:installGit', token),
  pluginsResolveTab: (registrationId: string) => ipcRenderer.invoke('plugins:resolveTab', registrationId),
  pluginsInvoke:     (request: unknown) => ipcRenderer.invoke('plugins:invoke', request),
  pluginsAudit:      () => ipcRenderer.invoke('plugins:audit'),
  pluginsSetApproval:(pluginId: string, approved: boolean) => ipcRenderer.invoke('plugins:setApproval', pluginId, approved),
  pluginsSetEnabled: (pluginId: string, enabled: boolean) => ipcRenderer.invoke('plugins:setEnabled', pluginId, enabled),
  pluginsOpenDir:    () => ipcRenderer.invoke('plugins:openDir'),
  pluginsOpenPluginDir:(pluginId: string) => ipcRenderer.invoke('plugins:openPluginDir', pluginId),
  pluginsOpenManifest:(pluginId: string) => ipcRenderer.invoke('plugins:openManifest', pluginId),
  pluginsRecordRuntimeError:(pluginId: string, registrationId: string, message: string) => ipcRenderer.invoke('plugins:recordRuntimeError', pluginId, registrationId, message),
  onPluginsChanged: (cb: (event: unknown) => void) => {
    const listener = (_e: unknown, event: unknown) => cb(event)
    ipcRenderer.on('plugins:changed', listener)
    void ipcRenderer.invoke('plugins:watch')
    return () => ipcRenderer.removeListener('plugins:changed', listener)
  },

  // ─── System monitor (CPU/mem stats + per-process daemon controls) ─
  systemStats:      () => ipcRenderer.invoke('system:stats'),
  systemProcesses:  () => ipcRenderer.invoke('system:processes'),
  systemStopDaemon: (bridgeId: string) => ipcRenderer.invoke('system:stopDaemon', bridgeId),

  // ─── Rate limits ───────────────────────────────────────────────
  rateLimits: {
    get: () => ipcRenderer.invoke('rateLimits:get') as Promise<RateLimitState>,
    refresh: () => ipcRenderer.invoke('rateLimits:refresh') as Promise<RateLimitState>,
    setPollingInterval: (ms: number) => ipcRenderer.invoke('rateLimits:setPollingInterval', ms),
    onUpdate: (cb: (state: RateLimitState) => void) => {
      const listener = (_e: unknown, state: RateLimitState) => cb(state)
      ipcRenderer.on('rateLimits:update', listener)
      return () => ipcRenderer.removeListener('rateLimits:update', listener)
    },
  },
})
