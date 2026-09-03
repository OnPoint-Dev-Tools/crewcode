import { useEffect, useRef, useCallback } from 'react'
import type { AgentProviderId, BridgeEvent, ChatPromptOptions, CustodyHaltPayload, Message, TurnFileChange, ModeLevel } from '../types'
import type { McpServerConfig } from './useSettings'
import type { CrewCoderMode } from '../../../shared/crewcoder-types'
import { extractFilePathsFromToolArgs, buildUnifiedDiff, extractProviderPatchChanges, isFileEditTool, resultHasPatchSignal, collectTouchedPaths } from './turn-file-edit-detect'
import { appendStreamChunk } from '../streaming/stream-chunks'
import { useNotifications } from './useNotifications'
import { clearLatestContextUsage } from './compaction-context'
import {
  activityFormForTool,
  settleActiveTurnActivities,
  settleCurrentTurnActivity,
  startNextTurnActivity,
  updateTurnActivity,
} from '../components/thread/turn-activity'

type BridgeToolPolicy = 'default' | 'read-only'

const STREAM_FLUSH_MS = 50

interface PendingStreamDelta {
  bridgeId: string
  tabId:    string
  turnId:   string
  kind:     'agent' | 'thinking'
  delta:    string
  timer:    ReturnType<typeof setTimeout> | null
}

interface PendingToolOutput {
  bridgeId:   string
  tabId:      string
  toolCallId: string
  output:     string
  stream?:    string
  timer:      ReturnType<typeof setTimeout> | null
}

interface BridgeState {
  // These are best-effort hints for O(1) lookups; the updaters always verify
  // against the actual array so double-invocation (React StrictMode) is safe.
  agentBubbleByTurn:    Record<string, number>
  agentSeqByTurn:       Record<string, number>
  activeThinkingByTurn: Record<string, number>
  thinkingSeqByTurn:    Record<string, number>
  toolByCallId:         Record<string, number>
  turnStartTimes:       Record<string, number>
  requestTurnById:      Record<string, string>
  pendingPromptStartedAt?: number
  // tool_start → "before" snapshot for the per-turn change tracker. The read
  // is fired off as a promise on tool_start; tool_end awaits it before
  // computing the patch. Only populated for tools that edit a single file.
  pendingFileEdits:     Record<string, { paths: string[]; beforeP: Record<string, Promise<string>> }>
}

function nowTime(): string {
  return new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

function workspaceRelativePath(cwd: string, filePath: string): string {
  const root = cwd.replace(/\\/g, '/').replace(/\/+$/, '')
  const target = filePath.replace(/\\/g, '/')
  if (target.toLowerCase() === root.toLowerCase()) return ''
  if (target.toLowerCase().startsWith(`${root.toLowerCase()}/`)) return target.slice(root.length + 1)
  return filePath
}

type SetMessages = (tabId: string, updater: (prev: Message[]) => Message[]) => void

interface UseAgentBridgeOpts {
  setMessagesForTab:  SetMessages
  // bridgeId → tabId so we can route events to the correct tab's thread
  bridgeToTab:        Record<string, string>
  // bridgeId → cwd so we can snapshot file contents at tool_start/tool_end
  bridgeToCwd:        Record<string, string>
  // bridgeId → mode so agent bubbles know which composer mode produced them
  bridgeToMode:       Record<string, ModeLevel>
  onRunningChange?:   (bridgeId: string, running: boolean) => void
  /**
   * Fired when a turn settles (normal end, error, or process close). The crew
   * Supervisor coordinator subscribes to this to know a worker has finished and
   * its reply can be relayed back into the group chat.
   */
  onTurnEnd?:         (bridgeId: string, tabId: string, turnId?: string) => void
  /**
   * Fired on every bridge event — a liveness heartbeat for idle watchdogs. The
   * event `type` is forwarded so a watchdog can tell a long-running tool call
   * (tool_start with no tool_end yet) apart from a genuinely silent turn.
   */
  onActivity?:        (bridgeId: string, tabId: string, type: BridgeEvent['type']) => void
  /** Surface provider ask/permission requests so the chat pane can answer them. */
  /** Surface transient provider startup/resume status without persisting chat noise. */
  onStatus?:          (bridgeId: string, message: string | null) => void
  onUserRequest?:     (tabId: string, request: Extract<BridgeEvent, { type: 'user_request' }>['request']) => void
  /** Bridge queued a follow-up locally (claude) — surface it in the composer. */
  onFollowUpQueued?:  (bridgeId: string, followUpId: string, text: string) => void
  /** A queued follow-up left the bridge queue (sent, user-removed, or cleared). */
  onFollowUpRemoved?: (bridgeId: string, followUpId: string) => void
  /** Clear answered provider requests from the chat pane. */
  onUserRequestResolved?: (tabId: string, requestId: string) => void
  /**
   * Fired when the main-process idle sweep stopped a long-idle bridge. The
   * registry drops the bridge's keys so the next prompt starts a fresh process
   * (which resumes the conversation via the saved id). No user-visible notice —
   * the thread is untouched.
   */
  onReleased?:        (bridgeId: string) => void
  /**
   * An execution-custody invariant tripped: authority granted to this thread is
   * no longer knowable, so privileged actions are refused until the user
   * reauthorizes. Carries the exact failed invariant and the preserved evidence.
   */
  onCustodyHalt?:     (tabId: string, bridgeId: string, halt: CustodyHaltPayload) => void
  /** The user reauthorized the thread; the halt banner clears. */
  onCustodyCleared?:  (tabId: string, scopeKey: string) => void
}

export function useAgentBridge({ setMessagesForTab, bridgeToTab, bridgeToCwd, bridgeToMode, onRunningChange, onTurnEnd, onActivity, onStatus, onUserRequest, onUserRequestResolved, onFollowUpQueued, onFollowUpRemoved, onReleased, onCustodyHalt, onCustodyCleared }: UseAgentBridgeOpts) {
  const { show } = useNotifications()
  const stateRef      = useRef<Record<string, BridgeState>>({})        // per bridgeId
  const streamBuffersRef = useRef<Record<string, PendingStreamDelta>>({})
  const toolOutputBuffersRef = useRef<Record<string, PendingToolOutput>>({})
  const stoppedBridgesRef = useRef<Set<string>>(new Set())
  const bridgeToTabRef = useRef(bridgeToTab)
  bridgeToTabRef.current = bridgeToTab
  const bridgeToCwdRef = useRef(bridgeToCwd)
  bridgeToCwdRef.current = bridgeToCwd
  const bridgeToModeRef = useRef(bridgeToMode)
  bridgeToModeRef.current = bridgeToMode
  const onTurnEndRef = useRef(onTurnEnd)
  onTurnEndRef.current = onTurnEnd
  const onActivityRef = useRef(onActivity)
  onActivityRef.current = onActivity
  const onStatusRef = useRef(onStatus)
  onStatusRef.current = onStatus
  const onUserRequestRef = useRef(onUserRequest)
  onUserRequestRef.current = onUserRequest
  const onUserRequestResolvedRef = useRef(onUserRequestResolved)
  onUserRequestResolvedRef.current = onUserRequestResolved
  const onFollowUpQueuedRef = useRef(onFollowUpQueued)
  onFollowUpQueuedRef.current = onFollowUpQueued
  const onFollowUpRemovedRef = useRef(onFollowUpRemoved)
  onFollowUpRemovedRef.current = onFollowUpRemoved
  const onReleasedRef = useRef(onReleased)
  onReleasedRef.current = onReleased
  const onCustodyHaltRef = useRef(onCustodyHalt)
  onCustodyHaltRef.current = onCustodyHalt
  const onCustodyClearedRef = useRef(onCustodyCleared)
  onCustodyClearedRef.current = onCustodyCleared
  const onRunningChangeRef = useRef(onRunningChange)
  onRunningChangeRef.current = onRunningChange

  function getState(bridgeId: string): BridgeState {
    let s = stateRef.current[bridgeId]
    if (!s) {
      s = { agentBubbleByTurn: {}, agentSeqByTurn: {}, activeThinkingByTurn: {}, thinkingSeqByTurn: {}, toolByCallId: {}, turnStartTimes: {}, requestTurnById: {}, pendingFileEdits: {} }
      stateRef.current[bridgeId] = s
    }
    return s
  }

  function appendToolForTurn(messages: Message[], message: Extract<Message, { kind: 'toolcall' }>): { next: Message[]; index: number } {
    const existingIdx = messages.findIndex(msg => msg.kind === 'toolcall' && msg.toolCallId === message.toolCallId)
    if (existingIdx !== -1) {
      const next = messages.slice()
      const cur = next[existingIdx] as Extract<Message, { kind: 'toolcall' }>
      next[existingIdx] = { ...cur, args: message.args, toolName: message.toolName || cur.toolName, status: cur.status === 'completed' ? cur.status : message.status }
      return { next, index: existingIdx }
    }
    return { next: [...messages, message], index: messages.length }
  }

  function streamKey(bridgeId: string, turnId: string, kind: PendingStreamDelta['kind']): string {
    return `${bridgeId}:${turnId}:${kind}`
  }

  function flushStreamBuffer(key: string): void {
    const pending = streamBuffersRef.current[key]
    if (!pending) return
    if (pending.timer) clearTimeout(pending.timer)
    delete streamBuffersRef.current[key]

    const { bridgeId, tabId, turnId, kind, delta } = pending
    if (!delta) return
    const st = getState(bridgeId)
    setMessagesForTab(tabId, m => {
      // Fold the visible phase transition into the same bounded stream write.
      // Updating activity for every raw provider delta still scanned the
      // transcript once per token even though text rendering was already
      // coalesced to 50 ms.
      const messages = updateTurnActivity(m, turnId, {
        status: 'in_progress',
        activeForm: kind === 'agent' ? 'Preparing response' : 'Analyzing request',
      })
      if (kind === 'agent') {
        const activeIdx = st.agentBubbleByTurn[turnId]
        if (activeIdx !== undefined && messages[activeIdx]?.kind === 'agent' && messages[activeIdx].turnId === turnId) {
          const next = messages.slice()
          const cur  = next[activeIdx] as Extract<Message, { kind: 'agent' }>
          next[activeIdx] = {
            ...cur,
            text:      (cur.text ?? '') + delta,
            chunks:    appendStreamChunk(cur.chunks, delta),
            streaming: true,
          }
          return next
        }
        const seq = (st.agentSeqByTurn[turnId] ?? 0) + 1
        st.agentSeqByTurn[turnId] = seq
        const newIdx = messages.length
        st.agentBubbleByTurn[turnId] = newIdx
        if (!st.turnStartTimes[turnId]) {
          st.turnStartTimes[turnId] = st.pendingPromptStartedAt ?? Date.now()
          delete st.pendingPromptStartedAt
        }
        return [...messages, {
          kind:      'agent',
          time:      nowTime(),
          blocks:    [],
          text:      delta,
          chunks:    appendStreamChunk(undefined, delta),
          turnId,
          processId: `${turnId}-agent-${seq}`,
          streaming: true,
          mode:      bridgeToModeRef.current[bridgeId],
        }]
      }

      const tIdx = st.activeThinkingByTurn[turnId]
      if (tIdx !== undefined && messages[tIdx]?.kind === 'thinking' && messages[tIdx].turnId === turnId) {
        const next = messages.slice()
        const cur  = next[tIdx] as Extract<Message, { kind: 'thinking' }>
        next[tIdx] = {
          ...cur,
          text:      cur.text + delta,
          chunks:    appendStreamChunk(cur.chunks, delta),
          streaming: true,
        }
        return next
      }
      // Providers can return to reasoning after a tool call. Starting a fresh
      // block here preserves original event order without per-token renders.
      const seq = (st.thinkingSeqByTurn[turnId] ?? 0) + 1
      st.thinkingSeqByTurn[turnId] = seq
      const newIdx = messages.length
      st.activeThinkingByTurn[turnId] = newIdx
      return [...messages, {
        kind:      'thinking',
        time:      nowTime(),
        turnId,
        segmentId: `${turnId}-thinking-${seq}`,
        text:      delta,
        chunks:    appendStreamChunk(undefined, delta),
        streaming: true,
      }]
    })
  }

  function flushBridgeBuffers(bridgeId: string): void {
    for (const key of Object.keys(streamBuffersRef.current)) {
      if (streamBuffersRef.current[key]?.bridgeId === bridgeId) flushStreamBuffer(key)
    }
  }

  function enqueueStreamDelta(bridgeId: string, tabId: string, turnId: string, kind: PendingStreamDelta['kind'], delta: string): void {
    const st = getState(bridgeId)
    if (kind === 'agent') {
      flushStreamBuffer(streamKey(bridgeId, turnId, 'thinking'))
      delete st.activeThinkingByTurn[turnId]
    } else {
      flushStreamBuffer(streamKey(bridgeId, turnId, 'agent'))
      delete st.agentBubbleByTurn[turnId]
    }

    const key = streamKey(bridgeId, turnId, kind)
    const existing = streamBuffersRef.current[key]
    if (existing) {
      existing.delta += delta
      return
    }
    const pending: PendingStreamDelta = { bridgeId, tabId, turnId, kind, delta, timer: null }
    pending.timer = setTimeout(() => flushStreamBuffer(key), STREAM_FLUSH_MS)
    streamBuffersRef.current[key] = pending
  }

  function flushToolOutputBuffer(key: string): void {
    const pending = toolOutputBuffersRef.current[key]
    if (!pending) return
    if (pending.timer) clearTimeout(pending.timer)
    delete toolOutputBuffersRef.current[key]

    const { tabId, toolCallId, output, stream } = pending
    setMessagesForTab(tabId, m => {
      const idx = m.findIndex(msg => msg.kind === 'toolcall' && msg.toolCallId === toolCallId)
      if (idx === -1 || m[idx]?.kind !== 'toolcall') return m
      const next = m.slice()
      const cur  = next[idx] as Extract<Message, { kind: 'toolcall' }>
      const metadata = { ...(cur.metadata ?? {}) } as Record<string, unknown>
      metadata.output = `${typeof metadata.output === 'string' ? metadata.output : ''}${output}`
      if (stream) metadata.stream = stream
      next[idx] = { ...cur, metadata }
      return next
    })
  }

  function flushBridgeToolOutputBuffers(bridgeId: string): void {
    for (const key of Object.keys(toolOutputBuffersRef.current)) {
      if (toolOutputBuffersRef.current[key]?.bridgeId === bridgeId) flushToolOutputBuffer(key)
    }
  }

  function enqueueToolOutput(bridgeId: string, tabId: string, toolCallId: string, stream: string | undefined, output: string): void {
    const key = `${bridgeId}:${toolCallId}:output`
    const existing = toolOutputBuffersRef.current[key]
    if (existing) {
      existing.output += output
      existing.stream = stream ?? existing.stream
      return
    }
    const pending: PendingToolOutput = { bridgeId, tabId, toolCallId, stream, output, timer: null }
    pending.timer = setTimeout(() => flushToolOutputBuffer(key), 120)
    toolOutputBuffersRef.current[key] = pending
  }

  useEffect(() => {
    const api = window.electronAPI
    if (!api) return

    const off = api.onBridgeEvent((raw) => {
      const ev = raw as BridgeEvent
      const bridgeId = ev.type === 'user_request' ? ev.request.bridgeId : ev.bridgeId
      // Hard-stopped bridges can still have queued IPC events; ignoring them
      // prevents a final assistant reply from landing after the user hit stop.
      if (stoppedBridgesRef.current.has(bridgeId)) return
      const tabId = bridgeToTabRef.current[bridgeId]
      if (!tabId) return
      const st = getState(bridgeId)

      // Liveness heartbeat — any event proves the bridge is still working. The
      // crew Supervisor uses this to reset its idle watchdog so a worker grinding
      // on a long task isn't mistaken for a hang.
      onActivityRef.current?.(bridgeId, tabId, ev.type)
      if (ev.type !== 'text_delta' && ev.type !== 'thinking_delta') flushBridgeBuffers(bridgeId)
      if (ev.type !== 'tool_update') flushBridgeToolOutputBuffers(bridgeId)

      const closeThinkingSegment = (turnId: string): void => {
        delete st.activeThinkingByTurn[turnId]
      }
      // A bridge that exits mid-turn never sends turn_end, so nothing else
      // clears the streaming flag: the spinner keeps running on a dead process
      // and silence reads as work in progress. Settle every in-flight bubble.
      const settleStreamingMessages = (): void => {
        // Tabs may host more than one agent. Settle only turns owned by this
        // bridge; clearing every streaming bubble would make a healthy sibling
        // agent look finished when this bridge exits.
        const turnIds = new Set([
          ...Object.keys(st.agentBubbleByTurn),
          ...Object.keys(st.activeThinkingByTurn),
          ...Object.keys(st.turnStartTimes),
        ])
        if (!turnIds.size) return
        setMessagesForTab(tabId, m => {
          let changed = false
          const next = m.map(msg => {
            if ((msg.kind !== 'agent' && msg.kind !== 'thinking') || !msg.streaming || !msg.turnId || !turnIds.has(msg.turnId)) return msg
            changed = true
            return { ...msg, streaming: false }
          })
          return changed ? next : m
        })
      }
      const closeAgentSegment = (turnId: string): void => {
        delete st.agentBubbleByTurn[turnId]
      }

      // Start a "before" snapshot for file-editing tool calls. Called on every
      // tool lifecycle event because some providers (opencode) stream the actual
      // args after tool_start. We only snapshot once per toolCallId.
      const ensurePendingFileEdit = (toolCallId: string, toolName: string, args: unknown): void => {
        const cwd   = bridgeToCwdRef.current[bridgeId]
        const paths = cwd
          ? extractFilePathsFromToolArgs(toolName, args).map(path => workspaceRelativePath(cwd, path))
          : []
        if (paths.length === 0 || !cwd) return
        const api = window.electronAPI
        if (!api) return
        const pending = st.pendingFileEdits[toolCallId] ?? { paths: [], beforeP: {} }
        for (const editPath of paths) {
          if (Object.prototype.hasOwnProperty.call(pending.beforeP, editPath)) continue
          pending.paths.push(editPath)
          pending.beforeP[editPath] = api.fsReadFile(cwd, editPath)
            .then(r => r.text ?? '')
            .catch(() => '')
        }
        st.pendingFileEdits[toolCallId] = pending
      }

      switch (ev.type) {
        case 'ready':
          return

        case 'status':
          onStatusRef.current?.(ev.bridgeId, ev.message)
          return

        case 'session_id':
          // Persisted by the main process; the renderer just needs to know
          // resumes happened so we don't double-render history later.
          return

        case 'turn_start':
          st.turnStartTimes[ev.turnId] = st.pendingPromptStartedAt ?? Date.now()
          delete st.pendingPromptStartedAt
          onStatusRef.current?.(ev.bridgeId, null)
          onRunningChangeRef.current?.(ev.bridgeId, true)
          setMessagesForTab(tabId, messages => startNextTurnActivity(messages, ev.turnId))
          // Lazily allocate bubbles when the first delta arrives.
          return

        case 'history_user': {
          setMessagesForTab(tabId, m => [...m, { kind: 'user', text: ev.text, time: nowTime() }])
          return
        }

        case 'history_agent': {
          closeThinkingSegment(ev.turnId)
          closeAgentSegment(ev.turnId)
          setMessagesForTab(tabId, m => {
            // A Brain claim sends a semantic replacement snapshot because final
            // deltas can race the old browser socket closing. Collapse every
            // persisted/detached fragment for this turn into one authoritative
            // bubble, then let later live deltas append to that same bubble.
            const existingIndex = m.findIndex(message => message.kind === 'agent' && message.turnId === ev.turnId)
            if (existingIndex !== -1) {
              const existing = m[existingIndex]!
              if (existing.kind !== 'agent') return m
              const next = m.filter((message, index) => index === existingIndex
                || message.kind !== 'agent'
                || message.turnId !== ev.turnId)
              const replacementIndex = next.indexOf(existing)
              next[replacementIndex] = {
                ...existing,
                text: ev.text,
                chunks: appendStreamChunk(undefined, ev.text),
                streaming: false,
              }
              st.agentBubbleByTurn[ev.turnId] = replacementIndex
              return next
            }
            st.agentBubbleByTurn[ev.turnId] = m.length
            return [...m, {
              kind:      'agent',
              time:      nowTime(),
              blocks:    [],
              text:      ev.text,
              chunks:    appendStreamChunk(undefined, ev.text),
              turnId:    ev.turnId,
              processId: `${ev.turnId}-agent-history`,
              streaming: false,
              mode:      bridgeToModeRef.current[ev.bridgeId],
            }]
          })
          return
        }

        case 'history_thinking': {
          closeThinkingSegment(ev.turnId)
          closeAgentSegment(ev.turnId)
          setMessagesForTab(tabId, m => [...m, {
            kind:      'thinking',
            time:      nowTime(),
            turnId:    ev.turnId,
            segmentId: `${ev.turnId}-thinking-history`,
            text:      ev.text,
            chunks:    appendStreamChunk(undefined, ev.text),
            streaming: false,
          }])
          return
        }

        case 'text_delta': {
          enqueueStreamDelta(ev.bridgeId, tabId, ev.turnId, 'agent', ev.delta)
          return
        }

        case 'thinking_delta': {
          enqueueStreamDelta(ev.bridgeId, tabId, ev.turnId, 'thinking', ev.delta)
          return
        }

        case 'tool_start': {
          closeThinkingSegment(ev.turnId)
          closeAgentSegment(ev.turnId)
          setMessagesForTab(tabId, messages => updateTurnActivity(messages, ev.turnId, {
            status: 'in_progress',
            activeForm: activityFormForTool(ev.toolName),
          }))
          setMessagesForTab(tabId, m => {
            const inserted = appendToolForTurn(m, {
              kind:       'toolcall',
              time:       nowTime(),
              turnId:     ev.turnId,
              toolCallId: ev.toolCallId,
              toolName:   ev.toolName,
              args:       ev.args,
              status:     'running',
            })
            st.toolByCallId[ev.toolCallId] = inserted.index
            return inserted.next
          })
          // Kick off a "before" snapshot for file-editing tool calls. Fires
          // in parallel with the tool's actual work so tool_end can resolve
          // the patch without blocking the UI.
          ensurePendingFileEdit(ev.toolCallId, ev.toolName, ev.args)
          return
        }

        case 'tool_update': {
          closeThinkingSegment(ev.turnId)
          const partial = (ev.partial && typeof ev.partial === 'object')
            ? ev.partial as Record<string, unknown>
            : undefined
          const output = typeof partial?.output === 'string' ? partial.output : ''
          if (output && ev.args === undefined && ev.title === undefined && Object.keys(partial ?? {}).every(k => k === 'output' || k === 'stream')) {
            enqueueToolOutput(ev.bridgeId, tabId, ev.toolCallId, typeof partial?.stream === 'string' ? partial.stream : undefined, output)
            return
          }

          flushToolOutputBuffer(`${ev.bridgeId}:${ev.toolCallId}:output`)
          // Opencode populates `state.input` / `state.title` after the initial
          // `tool_start`. Merge the latest args/title/metadata into the toolcall
          // message so the work-log row can re-render with the actual command,
          // filename, or pattern instead of the empty `{}` it had on creation.
          let toolName = ''
          setMessagesForTab(tabId, m => {
            const idx = st.toolByCallId[ev.toolCallId]
            if (idx === undefined || m[idx]?.kind !== 'toolcall') return m
            const next = m.slice()
            const cur  = next[idx] as Extract<Message, { kind: 'toolcall' }>
            toolName = cur.toolName
            next[idx] = {
              ...cur,
              args:     ev.args !== undefined ? ev.args : cur.args,
              title:    ev.title ?? cur.title,
              metadata: partial ? { ...(cur.metadata ?? {}), ...partial } : cur.metadata,
            }
            return next
          })
          // Opencode streams real tool args via updates, so start the before
          // snapshot as soon as we see a file path we missed at tool_start.
          ensurePendingFileEdit(ev.toolCallId, toolName, ev.args)
          ensurePendingFileEdit(ev.toolCallId, toolName, ev.partial)
          return
        }

        case 'tool_end': {
          closeThinkingSegment(ev.turnId)
          flushToolOutputBuffer(`${ev.bridgeId}:${ev.toolCallId}:output`)
          // tool_end carries no toolName; recover it from the stored toolcall so
          // the git fallback below can gate on whether this was a file edit.
          let endedToolName = ''
          let endedArgs: unknown = ev.args
          let endedMetadata: Record<string, unknown> | undefined
          setMessagesForTab(tabId, m => {
            const idx = st.toolByCallId[ev.toolCallId]
            if (idx === undefined || m[idx]?.kind !== 'toolcall') return m
            const next = m.slice()
            const cur  = next[idx] as Extract<Message, { kind: 'toolcall' }>
            endedToolName = cur.toolName
            endedArgs = ev.args !== undefined ? ev.args : cur.args
            endedMetadata = cur.metadata
            next[idx] = {
              ...cur,
              status:  ev.isError ? 'error' : 'completed',
              result:  ev.result,
              isError: ev.isError,
              // Opencode often only fills `state.input` / `state.title` by the
              // time the tool completes. Absorb whatever the bridge surfaces
              // on tool_end so the row title can finally render the command.
              args:    endedArgs,
              title:   ev.title ?? cur.title,
            }
            return next
          })
          setMessagesForTab(tabId, messages => updateTurnActivity(messages, ev.turnId, {
            status: 'in_progress',
            activeForm: ev.isError ? 'Recovering from tool error' : 'Working on request',
          }))
          // For file-editing tool calls: resolve the diff from (1) before/after
          // snapshots, (2) provider-embedded unified diffs, then (3) a scoped
          // git-diff fallback. Skipped entirely if the tool errored — nothing
          // was written. Always clear the pending snapshot so it can't leak.
          const pending = st.pendingFileEdits[ev.toolCallId]
          if (pending) delete st.pendingFileEdits[ev.toolCallId]
          if (!ev.isError) {
            const cwd = bridgeToCwdRef.current[ev.bridgeId]
            const api = window.electronAPI
            ;(async () => {
              const changes: TurnFileChange[] = []
              // 1. Before/after snapshots captured at tool_start — most precise.
              if (pending && cwd && api) {
                for (const path of pending.paths) {
                  const beforeText = await pending.beforeP[path]
                  const r          = await api.fsReadFile(cwd, path).catch(() => ({ text: '' }))
                  const afterText  = r.text ?? ''
                  const patch      = buildUnifiedDiff(path, beforeText, afterText)
                  if (!patch) continue   // no-op write: same content
                  changes.push({ path, beforeText, afterText, patch })
                }
              }
              // 2. Provider-embedded unified diffs (incl. nested result.details.diff).
              // This path is transport-neutral: browser clients have no
              // `window.electronAPI`, but provider patches are already present
              // in the transcript and still belong in the turn drawer.
              for (const change of extractProviderPatchChanges(endedMetadata, endedArgs, ev.result)) {
                const relPath = cwd ? workspaceRelativePath(cwd, change.path) : change.path
                if (changes.some(c => c.path === relPath)) continue
                changes.push({ path: relPath, beforeText: '', afterText: '', patch: change.patch })
              }
              // 3. Scoped git fallback: when the result format is one we can't
              // parse (e.g. a line-numbered preview) but the tool still wrote a
              // file, diff just the touched path(s) against the working tree.
              // Gated to plausible edits so reads/bash never trigger it, and
              // scoped to specific files so unrelated changes aren't attributed
              // to this turn.
              if (cwd && api && changes.length === 0 && (pending || isFileEditTool(endedToolName, endedArgs) || resultHasPatchSignal(endedMetadata, ev.result))) {
                const candidates = collectTouchedPaths(endedArgs, endedMetadata, ev.result)
                  .map(p => workspaceRelativePath(cwd, p))
                  .filter(Boolean)
                for (const path of candidates) {
                  const res  = await api.gitDiff(cwd, path, false).catch(() => null)
                  const diff = res && 'diff' in res && typeof res.diff === 'string' ? res.diff : ''
                  if (!diff.trim()) continue
                  changes.push({ path, beforeText: '', afterText: '', patch: diff })
                }
              }
              if (changes.length === 0) return
              setMessagesForTab(tabId, m => {
                const idx = st.toolByCallId[ev.toolCallId]
                if (idx === undefined || m[idx]?.kind !== 'toolcall') return m
                const next = m.slice()
                const cur  = next[idx] as Extract<Message, { kind: 'toolcall' }>
                next[idx] = { ...cur, fileChange: changes[0], fileChanges: changes }
                return next
              })
            })()
          }
          return
        }

        case 'usage_update': {
          setMessagesForTab(tabId, m => {
            let lastAgentIdx = -1
            for (let i = 0; i < m.length; i++) {
              const msg = m[i]
              if (msg.kind === 'agent' && msg.turnId === ev.turnId) lastAgentIdx = i
            }
            if (lastAgentIdx === -1) return m
            const next = m.slice()
            const msg = next[lastAgentIdx] as Extract<Message, { kind: 'agent' }>
            next[lastAgentIdx] = { ...msg, usage: ev.usage }
            return next
          })
          return
        }

        case 'handoff_summary': {
          setMessagesForTab(tabId, m => [...m, {
            kind: 'handoff_summary',
            time: nowTime(),
            summary: ev.summary,
            fromProvider: ev.fromProvider,
            toProvider: ev.toProvider,
            reason: ev.reason,
          }])
          return
        }

        case 'compaction_event': {
          const provider = ev.provider ?? 'provider'
          const fallback = ev.automatic
            ? `${provider} auto-compacted context. Continue the conversation normally.`
            : ev.status === 'completed'
              ? 'Session compacted. Continue the conversation normally.'
              : ev.status === 'failed'
                ? 'Session compaction failed.'
                : 'Session compaction started.'
          const message = ev.message ?? fallback
          const noticeType = ev.status === 'failed' ? 'error' : ev.automatic ? 'warning' : ev.status === 'completed' ? 'success' : 'info'
          show({ type: noticeType, message, duration: ev.status === 'started' ? 3000 : 6000 })
          setMessagesForTab(tabId, m => {
            const base = ev.resetContext ? clearLatestContextUsage(m) : m
            const activeIdx = [...base].reverse().findIndex(msg => msg.kind === 'compaction' && msg.bridgeId === bridgeId && msg.status === 'started')
            const idx = activeIdx === -1 ? -1 : base.length - 1 - activeIdx
            if (idx !== -1) {
              const next = base.slice()
              next[idx] = {
                kind: 'compaction',
                bridgeId,
                time: nowTime(),
                status: ev.status,
                automatic: ev.automatic,
                message,
                percent: ev.percent,
                provider,
              }
              return next
            }
            return [...base, {
              kind: 'compaction',
              bridgeId,
              time: nowTime(),
              status: ev.status,
              automatic: ev.automatic,
              message,
              percent: ev.percent,
              provider,
            }]
          })
          return
        }

        case 'user_request': {
          if (ev.request.turnId) st.requestTurnById[ev.request.requestId] = ev.request.turnId
          setMessagesForTab(tabId, messages => updateTurnActivity(messages, ev.request.turnId, {
            status: 'in_progress',
            activeForm: 'Waiting for your response',
          }))
          onUserRequestRef.current?.(tabId, ev.request)
          return
        }

        case 'user_request_resolved': {
          const requestTurnId = st.requestTurnById[ev.requestId]
          delete st.requestTurnById[ev.requestId]
          if (requestTurnId) {
            setMessagesForTab(tabId, messages => updateTurnActivity(messages, requestTurnId, {
              status: 'in_progress',
              activeForm: 'Working on request',
            }))
          }
          onUserRequestResolvedRef.current?.(tabId, ev.requestId)
          return
        }

        case 'follow_up_queued': {
          onFollowUpQueuedRef.current?.(ev.bridgeId, ev.followUpId, ev.text)
          return
        }

        case 'follow_up_removed': {
          onFollowUpRemovedRef.current?.(ev.bridgeId, ev.followUpId)
          return
        }

        case 'turn_end': {
          const startTime = st.turnStartTimes[ev.turnId]
          const durationMs = startTime ? Date.now() - startTime : undefined
          onStatusRef.current?.(ev.bridgeId, null)
          onRunningChangeRef.current?.(ev.bridgeId, false)
          closeThinkingSegment(ev.turnId)
          setMessagesForTab(tabId, messages => settleCurrentTurnActivity(messages, 'completed', ev.turnId))
          setMessagesForTab(tabId, m => {
            let changed = false
            let lastAgentIdx = -1
            for (let i = 0; i < m.length; i++) {
              const msg = m[i]
              if (msg.kind === 'agent' && msg.turnId === ev.turnId) lastAgentIdx = i
            }

            const next = m.slice()
            for (let i = 0; i < next.length; i++) {
              const msg = next[i]
              if (msg.kind === 'agent' && msg.turnId === ev.turnId) {
                const isFinalAgent = i === lastAgentIdx
                next[i] = {
                  ...msg,
                  streaming: false,
                  durationMs: isFinalAgent ? durationMs : undefined,
                  usage:      isFinalAgent ? (ev.usage ?? msg.usage) : undefined,
                }
                changed = true
                continue
              }
              if (msg.kind !== 'thinking' || msg.turnId !== ev.turnId || !msg.streaming) continue
              next[i] = { ...msg, streaming: false }
              changed = true
            }
            return changed ? next : m
          })
          delete st.turnStartTimes[ev.turnId]
          delete st.agentBubbleByTurn[ev.turnId]
          delete st.agentSeqByTurn[ev.turnId]
          delete st.thinkingSeqByTurn[ev.turnId]
          onTurnEndRef.current?.(ev.bridgeId, tabId, ev.turnId)
          return
        }

        case 'error': {
          st.turnStartTimes = {}
          delete st.pendingPromptStartedAt
          onStatusRef.current?.(ev.bridgeId, null)
          onRunningChangeRef.current?.(ev.bridgeId, false)
          settleStreamingMessages()
          setMessagesForTab(tabId, messages => settleActiveTurnActivities(messages, 'interrupted'))
          setMessagesForTab(tabId, m => [...m, { kind: 'system', tone: 'error', text: ev.message, time: nowTime() }])
          onTurnEndRef.current?.(ev.bridgeId, tabId)
          return
        }

        case 'closed': {
          st.turnStartTimes = {}
          delete st.pendingPromptStartedAt
          onStatusRef.current?.(ev.bridgeId, null)
          onRunningChangeRef.current?.(ev.bridgeId, false)
          settleStreamingMessages()
          setMessagesForTab(tabId, messages => settleActiveTurnActivities(messages, 'interrupted'))
          setMessagesForTab(tabId, m => [...m, { kind: 'system', tone: 'info', text: `agent exited (${ev.code ?? 'unknown'})`, time: nowTime() }])
          onTurnEndRef.current?.(ev.bridgeId, tabId)
          return
        }

        // ─── Execution custody ────────────────────────────────────────────
        // An invariant tripped. The thread refuses privileged actions until the
        // user reauthorizes; main has already contained and preserved. All the
        // renderer does is report it loudly and stop pretending work continues.
        case 'custody_halt': {
          st.turnStartTimes = {}
          delete st.pendingPromptStartedAt
          onStatusRef.current?.(ev.bridgeId, null)
          onRunningChangeRef.current?.(ev.bridgeId, false)
          settleStreamingMessages()
          setMessagesForTab(tabId, messages => settleActiveTurnActivities(messages, 'interrupted'))
          onCustodyHaltRef.current?.(tabId, ev.bridgeId, ev.halt)
          onTurnEndRef.current?.(ev.bridgeId, tabId)
          // Main tore the process down as containment; drop the dead bridge id
          // so a reauthorized prompt starts a fresh one instead of retrying it.
          onReleasedRef.current?.(ev.bridgeId)
          delete stateRef.current[ev.bridgeId]
          return
        }

        case 'custody_cleared': {
          onCustodyClearedRef.current?.(tabId, ev.scopeKey)
          return
        }

        case 'custody_deferred': {
          setMessagesForTab(tabId, m => [...m, { kind: 'system', tone: 'info', text: ev.message, time: nowTime() }])
          return
        }

        case 'idle_stopped': {
          // Idle sweep freed the process. Drop local state and let the registry
          // forget the bridge — no thread message; the next prompt resumes it.
          onStatusRef.current?.(ev.bridgeId, null)
          onRunningChangeRef.current?.(ev.bridgeId, false)
          setMessagesForTab(tabId, messages => settleActiveTurnActivities(messages, 'interrupted'))
          onReleasedRef.current?.(ev.bridgeId)
          delete stateRef.current[ev.bridgeId]
          return
        }
      }
    })

    return () => {
      for (const key of Object.keys(streamBuffersRef.current)) flushStreamBuffer(key)
      for (const key of Object.keys(toolOutputBuffersRef.current)) flushToolOutputBuffer(key)
      off()
    }
  }, [setMessagesForTab, show])

  /** Install event routing synchronously before a remote bridge can emit. */
  const registerRoute = useCallback((bridgeId: string, tabId: string, cwd: string, mode?: ModeLevel) => {
    bridgeToTabRef.current = { ...bridgeToTabRef.current, [bridgeId]: tabId }
    bridgeToCwdRef.current = { ...bridgeToCwdRef.current, [bridgeId]: cwd }
    if (mode) bridgeToModeRef.current = { ...bridgeToModeRef.current, [bridgeId]: mode }
  }, [])

  const start = useCallback(async (
    bridgeId:   string,
    provider:   AgentProviderId,
    cwd:        string,
    model?:     string,
    mode?:      ModeLevel,
    thinking?:  'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra',
    toolPolicy?: BridgeToolPolicy,
    sessionKey?: string,
    conversationScopeKey?: string,
    mcpServers?: McpServerConfig[],
    freshSession?: boolean,
    externalDirectories?: string[],
    crewcoderMode?: CrewCoderMode,
    crewcoderApprovalMode?: import('../../../shared/crewcoder-types').CrewCoderApprovalMode,
  ) => {
    stoppedBridgesRef.current.delete(bridgeId)
    const api = window.electronAPI
    if (!api) return { ok: false, error: 'electronAPI unavailable' }
    try {
      return await api.bridgeStart({ bridgeId, provider, cwd, externalDirectories, model, mode, crewcoderMode, crewcoderApprovalMode, toolPolicy, thinking, sessionKey, conversationScopeKey, freshSession, mcpServers })
    } catch (error) {
      return { ok: false, error: (error as Error).message }
    }
  }, [])

  const prompt = useCallback(async (bridgeId: string, text: string, options?: ChatPromptOptions) => {
    const st = getState(bridgeId)
    // User-visible elapsed time should cover the whole request, not only the
    // provider's final text stream; some bridges emit turn_start after setup.
    st.pendingPromptStartedAt = Date.now()
    onRunningChangeRef.current?.(bridgeId, true)
    try {
      const result = await (window.electronAPI?.bridgePrompt(bridgeId, text, options) ?? { ok: false, error: 'electronAPI unavailable' })
      // Browser RPC and some provider bridges acknowledge an accepted prompt
      // before the turn finishes. Keep Stop available until an authoritative
      // turn_end/error/closed event arrives; an RPC acknowledgement is not proof
      // that execution settled. Rejections have no terminal turn to clear them.
      if (!result.ok) onRunningChangeRef.current?.(bridgeId, false)
      return result
    } catch (error) {
      onRunningChangeRef.current?.(bridgeId, false)
      return { ok: false, error: (error as Error).message }
    }
  }, [])

  const compact = useCallback(async (bridgeId: string) => {
    onRunningChangeRef.current?.(bridgeId, true)
    try {
      return await (window.electronAPI?.bridgeCompact(bridgeId) ?? { ok: false, error: 'electronAPI unavailable' })
    } finally {
      onRunningChangeRef.current?.(bridgeId, false)
    }
  }, [])

  const handoff = useCallback(async (bridgeId: string, sourceConversationKey: string, options: NonNullable<ChatPromptOptions['handoff']>) => {
    onRunningChangeRef.current?.(bridgeId, true)
    try {
      return await (window.electronAPI?.bridgeHandoff(bridgeId, sourceConversationKey, options) ?? { ok: false, error: 'handoff unavailable' })
    } finally {
      onRunningChangeRef.current?.(bridgeId, false)
    }
  }, [])

  const setMode = useCallback((bridgeId: string, mode: ModeLevel) => {
    // Mode switches are per-turn behavior, not a reason to respawn and lose the
    // provider's live context. Mutate the routing ref immediately for fast events.
    bridgeToModeRef.current = { ...bridgeToModeRef.current, [bridgeId]: mode }
    window.electronAPI?.bridgeSetMode?.(bridgeId, mode)
  }, [])

  const abort = useCallback((bridgeId: string) => {
    const tabId = bridgeToTabRef.current[bridgeId]
    if (tabId) setMessagesForTab(tabId, messages => settleActiveTurnActivities(messages, 'cancelled'))
    window.electronAPI?.bridgeAbort(bridgeId)
  }, [setMessagesForTab])

  const removeFollowUp = useCallback(async (bridgeId: string, followUpId: string) => {
    return await (window.electronAPI?.bridgeRemoveFollowUp(bridgeId, followUpId)
      ?? { ok: false, error: 'electronAPI unavailable' })
  }, [])

  const stop = useCallback((bridgeId: string, preserveActivity = false) => {
    stoppedBridgesRef.current.add(bridgeId)
    onRunningChangeRef.current?.(bridgeId, false)
    flushBridgeBuffers(bridgeId)
    flushBridgeToolOutputBuffers(bridgeId)
    const tabId = bridgeToTabRef.current[bridgeId]
    if (!preserveActivity && tabId) setMessagesForTab(tabId, messages => settleActiveTurnActivities(messages, 'interrupted'))
    window.electronAPI?.bridgeStop(bridgeId)
    delete stateRef.current[bridgeId]
  }, [setMessagesForTab])

  return { start, prompt, compact, handoff, setMode, abort, stop, removeFollowUp, registerRoute }
}
