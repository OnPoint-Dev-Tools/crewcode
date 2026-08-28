import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import { Icon } from '../ui/Icon'
import { Messages } from '../thread/Messages'
import { AgentActivityOverlay } from '../thread/AgentActivityOverlay'
import { latestTodoActivity } from '../thread/todo-from-toolcall'
import { CREWCODER_APPROVE_PLAN_PROMPT, latestCrewCoderPlanGate } from '../thread/crewcoder-plan-gate'
import { MentionPopover } from '../composer/MentionPopover'
import { PROVIDER_IMAGES, providerImageClass } from '../composer/provider-meta'
import { useSettings } from '../../hooks/useSettings'
import type { AgentInfo, AgentUserRequest, AgentUserResponse, Message } from '../../types'
import type { CrewSession } from '../../orchestrator/crew-session'

interface MentionState {
  start: number
  query: string
}

const workspaceFileCache = new Map<string, string[]>()
const workspaceFileLoads = new Map<string, Promise<string[]>>()

function findMentionAt(value: string, caret: number): MentionState | null {
  let i = caret - 1
  while (i >= 0) {
    const ch = value[i]
    if (ch === '@') {
      const before = value[i - 1]
      if (i === 0 || /\s/.test(before) || before === '(' || before === ',') {
        return { start: i, query: value.slice(i + 1, caret) }
      }
      return null
    }
    if (/\s/.test(ch)) return null
    i--
  }
  return null
}

interface SupervisorSidebarProps {
  session:       CrewSession
  agents:        AgentInfo[]
  messagesByTab: Record<string, Message[]>
  onSend:        (text: string) => void
  onStop:        () => void
  agentRequest?: AgentUserRequest | null
  onAgentRequestResponse?: (response: AgentUserResponse) => void | Promise<unknown>
  collapsed:     boolean
  onToggle:      () => void
  width:         number
}

const STATUS_COPY: Record<CrewSession['supervisor']['status'], string> = {
  idle:       'ready',
  thinking:   'thinking…',
  delegating: 'delegating…',
  error:      'error',
}

/**
 * The Supervisor group-chat sidebar — the user talks to the moderator here while
 * the lane columns/timeline keep showing each worker's full thread. Reuses the
 * thread `Messages` renderer; worker replies arrive as labeled incoming bubbles.
 */
export function SupervisorSidebar({
  session, agents, messagesByTab, onSend, onStop, agentRequest, onAgentRequestResponse, collapsed, onToggle, width,
}: SupervisorSidebarProps) {
  const { state: settings, set: setSetting } = useSettings()
  const [draft, setDraft] = useState('')
  const [files, setFiles] = useState<string[]>([])
  const [mention, setMention] = useState<MentionState | null>(null)
  const [showScrollBottom, setShowScrollBottom] = useState(false)
  const threadRef = useRef<HTMLDivElement>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)

  const supe = session.supervisor
  const tabId = supe.tabId ?? `crew/${session.id}/supervisor`
  const messages = messagesByTab[tabId] ?? []
  const agentLabel = useMemo(
    () => agents.find(a => a.id === supe.agentId)?.name ?? supe.agentId,
    [agents, supe.agentId])

  const busy = supe.status === 'thinking' || supe.status === 'delegating'
  const todoActivity = useMemo(() => latestTodoActivity(messages), [messages])
  const planGate = useMemo(() => latestCrewCoderPlanGate(messages), [messages])

  const updateScrollBottomButton = () => {
    const el = threadRef.current
    if (!el) return
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight
    setShowScrollBottom(distance > 80)
  }

  const scrollToBottom = () => {
    const el = threadRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    setShowScrollBottom(false)
  }

  useEffect(() => {
    requestAnimationFrame(updateScrollBottomButton)
  }, [messages.length])

  useEffect(() => {
    if (!session.basePath) { setFiles([]); return }
    setFiles(workspaceFileCache.get(session.basePath) ?? [])
  }, [session.basePath])

  useEffect(() => {
    if (!mention || !session.basePath || workspaceFileCache.has(session.basePath)) return
    let cancelled = false
    const api = window.electronAPI
    if (!api) return
    const load = workspaceFileLoads.get(session.basePath) ?? api.fsListFiles(session.basePath)
      .then(res => {
        const next = res.files ?? []
        workspaceFileCache.set(session.basePath, next)
        workspaceFileLoads.delete(session.basePath)
        return next
      })
      .catch(() => {
        workspaceFileLoads.delete(session.basePath)
        return []
      })
    workspaceFileLoads.set(session.basePath, load)
    load.then(next => { if (!cancelled) setFiles(next) })
    return () => { cancelled = true }
  }, [mention, session.basePath])

  const updateMentionFromCaret = () => {
    const ta = taRef.current
    if (!ta) return
    const caret = ta.selectionStart ?? draft.length
    setMention(findMentionAt(draft, caret))
  }

  useEffect(() => {
    const ta = taRef.current
    if (!ta) return
    const caret = ta.selectionStart ?? draft.length
    setMention(findMentionAt(draft, caret))
  }, [draft])

  useLayoutEffect(() => {
    const ta = taRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(180, Math.max(46, ta.scrollHeight))}px`
  }, [draft])

  const pickMention = (rel: string) => {
    const ta = taRef.current
    if (!ta || !mention) return
    const caret = ta.selectionStart ?? draft.length
    const before = draft.slice(0, mention.start)
    const after = draft.slice(caret)
    const token = `@${rel} `
    const next = before + token + after
    setDraft(next)
    setMention(null)
    requestAnimationFrame(() => {
      ta.focus()
      const pos = before.length + token.length
      ta.setSelectionRange(pos, pos)
    })
  }

  const send = () => {
    const text = draft.trim()
    if (!text) return
    onSend(text)
    setDraft('')
  }

  if (collapsed) {
    return (
      <button type="button" className="supervisor-rail" onClick={onToggle} title="open supervisor">
        <Icon name="crew" size={14} />
        <span className="supervisor-rail-label">supervisor</span>
      </button>
    )
  }

  return (
    <aside className="supervisor-sidebar" style={{ width, flexBasis: width, maxWidth: width }}>
      <header className="supervisor-head">
        <div className="supervisor-title">
          <span>Crew supervisor</span>
          {PROVIDER_IMAGES[supe.agentId]
            ? <img src={PROVIDER_IMAGES[supe.agentId]} alt={agentLabel} title={agentLabel} className={`supervisor-agent-logo ${providerImageClass(supe.agentId)}`} width={16} height={16} />
            : <span className="supervisor-agent-logo-fallback" title={agentLabel}>{supe.agentId.slice(0, 2)}</span>}
        </div>
        <div className="supervisor-head-right">
          <button
            type="button"
            className={`crew-btn-ghost ${settings.hideVerboseAgentLogs ? 'on' : ''}`}
            onClick={() => setSetting('hideVerboseAgentLogs', !settings.hideVerboseAgentLogs)}
            title={settings.hideVerboseAgentLogs ? 'Show thinking and tool logs' : 'Hide thinking and tool logs'}
            aria-pressed={settings.hideVerboseAgentLogs}
          >
            <Icon name={settings.hideVerboseAgentLogs ? 'eyeOff' : 'eye'} size={12} />
          </button>
          <span className={`supervisor-status status-${supe.status}`}>{STATUS_COPY[supe.status]}</span>
          <button type="button" className="crew-btn-ghost" onClick={onToggle} title="collapse supervisor">
            <Icon name="chevLeft" size={12} />
          </button>
        </div>
      </header>

      <div className="supervisor-thread" ref={threadRef} onScroll={updateScrollBottomButton}> 
        {messages.length === 0
          ? <div className="supervisor-empty">
              ask the supervisor to coordinate the crew — it delegates to the configured workers and reports back.
            </div>
          : <Messages messages={messages} isRunning={busy} />}
        {showScrollBottom && (
          <button type="button" className="supervisor-scroll-bottom" onClick={scrollToBottom} title="scroll to latest supervisor message">
            <Icon name="arrowDown" size={12} />
          </button>
        )}
      </div>

      <div className="supervisor-composer">
        {(agentRequest || todoActivity || planGate) && (
          <div className="composer-activity-shell">
            <AgentActivityOverlay
              todos={todoActivity?.todos ?? []}
              isStreaming={todoActivity?.isStreaming ?? busy}
              request={agentRequest ?? undefined}
              onRespond={onAgentRequestResponse}
              planGate={planGate}
              onApprovePlan={() => onSend(CREWCODER_APPROVE_PLAN_PROMPT)}
            />
          </div>
        )}
        <div className="supervisor-ta-wrap">
          <textarea
            ref={taRef}
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => {
              if (mention && ['ArrowUp', 'ArrowDown', 'Enter', 'Tab', 'Escape'].includes(e.key)) return
            }}
            onKeyUp={updateMentionFromCaret}
            onClick={updateMentionFromCaret}
            onBlur={() => setTimeout(() => setMention(null), 120)}
            placeholder="message the supervisor… use @ to add files"
            rows={2}
          />
          {mention && (
            <MentionPopover
              files={files}
              query={mention.query}
              onPick={pickMention}
              onClose={() => setMention(null)}
            />
          )}
        </div>
        {busy && (
          <button type="button" className="supervisor-stop" onClick={onStop} title="stop supervisor only">
            <Icon name="square" size={12} />
          </button>
        )}
        <button type="button" className="supervisor-send" onClick={send} disabled={!draft.trim()}>
          <Icon name="send" size={13} />
        </button>
      </div>
    </aside>
  )
}
