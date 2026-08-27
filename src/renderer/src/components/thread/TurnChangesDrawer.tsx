import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../ui/Icon'
import { PierreDiff } from '../diff/PierreDiff'
import { collectTurnChangeEntries } from './turn-changes-data'
import type { TurnChangeTarget } from './turn-changes-data'
import type { Message } from '../../types'

const WIDTH_KEY          = 'crewcode:turnChangesDrawerWidth'
const LIST_WIDTH_KEY     = 'crewcode:turnChangesDrawerListWidth'
const DEFAULT_WIDTH      = 720
const MIN_WIDTH          = 360
const DEFAULT_LIST_WIDTH = 260
const MIN_LIST_WIDTH     = 180
const MIN_DIFF_WIDTH     = 260
const MAX_AGENT_SUMMARIES = 20
function clampWidth(w: number): number {
  const max = Math.max(MIN_WIDTH, Math.floor(window.innerWidth * 0.95))
  return Math.max(MIN_WIDTH, Math.min(max, w))
}
function clampListWidth(w: number, drawerWidth = DEFAULT_WIDTH): number {
  const max = Math.max(MIN_LIST_WIDTH, drawerWidth - MIN_DIFF_WIDTH)
  return Math.max(MIN_LIST_WIDTH, Math.min(max, w))
}
function loadWidth(): number {
  const raw = Number(localStorage.getItem(WIDTH_KEY))
  return Number.isFinite(raw) && raw > 0 ? clampWidth(raw) : DEFAULT_WIDTH
}
function loadListWidth(): number {
  const raw = Number(localStorage.getItem(LIST_WIDTH_KEY))
  return Number.isFinite(raw) && raw > 0 ? clampListWidth(raw, loadWidth()) : DEFAULT_LIST_WIDTH
}

interface TurnChangesDrawerProps {
  open:     boolean
  messages: Message[]
  onClose:  () => void
  target?:  TurnChangeTarget | null
}

interface AgentFinalMessageEntry {
  turnId:  string
  time:    string
  userMsg: string | null
  text:    string
}

function agentMessageText(msg: Extract<Message, { kind: 'agent' }>): string {
  const fromText = msg.text?.trim()
  if (fromText) return fromText
  const fromChunks = msg.chunks?.join('').trim()
  if (fromChunks) return fromChunks
  return msg.blocks
    .map(([, text]) => text)
    .join('\n')
    .trim()
}

function userMessageBefore(messages: Message[], index: number): string | null {
  const userPrev = index > 0
    ? [...messages.slice(0, index)].reverse().find(m => m.kind === 'user')
    : null
  return userPrev?.kind === 'user' ? userPrev.text : null
}

function truncateText(text: string, length: number): string {
  return text.length > length ? `${text.slice(0, length)}…` : text
}

/**
 * Cross-turn history of file mutations for the active tab — opened from the
 * chat header. Lets the user scrub back through every turn that touched
 * disk and pop open any file's Pierre diff. The inline affordance under each
 * bubble handles the just-finished turn; this is the catalogue view.
 */
export function TurnChangesDrawer({ open, messages, onClose, target = null }: TurnChangesDrawerProps) {
  const turns = useMemo(() => collectTurnChangeEntries(messages), [messages])

  const finalAgentMessages = useMemo<AgentFinalMessageEntry[]>(() => {
    const byTurn = new Map<string, AgentFinalMessageEntry>()
    for (let i = 0; i < messages.length; i += 1) {
      const msg = messages[i]
      if (msg.kind !== 'agent' || !msg.turnId) continue
      const text = agentMessageText(msg)
      if (!text) continue
      // Keep only the latest agent bubble per turn so the section reads like a
      // compact outcome log instead of replaying the full conversation.
      byTurn.set(msg.turnId, {
        turnId:  msg.turnId,
        time:    msg.time,
        userMsg: userMessageBefore(messages, i),
        text,
      })
    }
    return [...byTurn.values()].reverse().slice(0, MAX_AGENT_SUMMARIES)
  }, [messages])

  const [activeTurn, setActiveTurn] = useState<string | null>(null)
  const [activeFile, setActiveFile] = useState<string | null>(null)
  const [activeFinalMessageTurn, setActiveFinalMessageTurn] = useState<string | null>(null)
  const [finalMessagesOpen, setFinalMessagesOpen] = useState(true)

  // Resizable width — drag handle on the left edge. Persisted across sessions.
  const [width, setWidth] = useState<number>(() => loadWidth())
  const [listWidth, setListWidth] = useState<number>(() => loadListWidth())
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const widthRef = useRef(width)
  const listWidthRef = useRef(listWidth)
  widthRef.current = width
  listWidthRef.current = listWidth
  const draggingRef = useRef(false)
  const listDraggingRef = useRef(false)
  const drawerRef = useRef<HTMLDivElement>(null)

  // A changed-file chip is a direct inspection route: focus its exact diff and
  // close the summaries/list sidebar before paint so the diff gets full width.
  useLayoutEffect(() => {
    if (!open || !target) return
    setActiveFinalMessageTurn(null)
    setActiveTurn(target.turnId)
    setActiveFile(target.filePath)
    setSidebarOpen(false)
  }, [open, target])
  const onHandleDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    draggingRef.current = true
    document.body.style.cursor     = 'ew-resize'
    document.body.style.userSelect = 'none'
  }, [])
  const onListHandleDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    listDraggingRef.current = true
    document.body.style.cursor     = 'col-resize'
    document.body.style.userSelect = 'none'
  }, [])
  useEffect(() => {
    if (!open) return
    const onMove = (e: MouseEvent) => {
      if (draggingRef.current) {
        const right = drawerRef.current?.getBoundingClientRect().right ?? window.innerWidth
        const clamped = clampWidth(right - e.clientX)
        const clampedList = clampListWidth(listWidthRef.current, clamped)
        widthRef.current = clamped
        listWidthRef.current = clampedList
        setWidth(clamped)
        setListWidth(clampedList)
        return
      }
      if (!listDraggingRef.current) return
      const bounds = drawerRef.current?.getBoundingClientRect()
      const right = bounds?.right ?? window.innerWidth
      const drawerWidth = bounds?.width ?? widthRef.current
      const clamped = clampListWidth(right - e.clientX, drawerWidth)
      listWidthRef.current = clamped
      setListWidth(clamped)
    }
    const onUp = () => {
      if (!draggingRef.current && !listDraggingRef.current) return
      draggingRef.current = false
      listDraggingRef.current = false
      document.body.style.cursor     = ''
      document.body.style.userSelect = ''
      try {
        localStorage.setItem(WIDTH_KEY, String(widthRef.current))
        localStorage.setItem(LIST_WIDTH_KEY, String(listWidthRef.current))
      } catch { /* quota — non-fatal */ }
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup',   onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup',   onUp)
      document.body.style.cursor     = ''
      document.body.style.userSelect = ''
    }
  }, [open])

  if (!open) return null

  const activeFinalMessage = finalAgentMessages.find(m => m.turnId === activeFinalMessageTurn) ?? null
  const turn   = activeFinalMessage ? null : turns.find(t => t.turnId === activeTurn) ?? turns[0] ?? null
  const change = turn?.changes.find(c => c.path === activeFile) ?? turn?.changes[0] ?? null

  return (
    <div className="turn-drawer" style={{ width }} ref={drawerRef}>
      <div
        className="turn-drawer-resize"
        onMouseDown={onHandleDown}
        title="drag to resize"
        role="separator"
        aria-orientation="vertical"
      />
      <header className="turn-drawer-head">
        <Icon name="gitCompare" size={13} />
        <span className="turn-drawer-title">Changes by turn</span>
        <button
          type="button"
          className={`turn-drawer-sidebar-toggle ${sidebarOpen ? 'on' : ''}`}
          onClick={() => setSidebarOpen(open => !open)}
          title={sidebarOpen ? 'hide turns sidebar' : 'show turns sidebar'}
          aria-pressed={sidebarOpen}
        >
          <Icon name="sidebar" size={13} />
        </button>
        <button type="button" className="turn-drawer-close" onClick={onClose} title="close">×</button>
      </header>

      {turns.length === 0 && finalAgentMessages.length === 0 && (
        <div className="turn-drawer-empty">no file changes or final messages recorded yet</div>
      )}

      {(turns.length > 0 || finalAgentMessages.length > 0) && (
        <div
          className={`turn-drawer-body ${sidebarOpen ? '' : 'sidebar-closed'}`}
          style={{ gridTemplateColumns: sidebarOpen ? `minmax(0, 1fr) 6px ${listWidth}px` : 'minmax(0, 1fr)' }}
        >
          {sidebarOpen && (
            <>
              <div className="turn-drawer-list">
                <section className="turn-drawer-section" aria-labelledby="turn-drawer-final-title">
                  <button
                    type="button"
                    className="turn-drawer-section-toggle"
                    onClick={() => setFinalMessagesOpen(open => !open)}
                    aria-expanded={finalMessagesOpen}
                    aria-controls="turn-drawer-final-list"
                  >
                    <Icon name={finalMessagesOpen ? 'chevDown' : 'chevRight'} size={12} />
                    <span className="turn-drawer-section-title" id="turn-drawer-final-title">Agent Summary</span>
                    <span className="turn-drawer-section-count mono">{finalAgentMessages.length}</span>
                  </button>
                  {finalMessagesOpen && (finalAgentMessages.length === 0 ? (
                    <div className="turn-drawer-section-empty">no final messages yet</div>
                  ) : (
                    <ul className="turn-drawer-final-list" id="turn-drawer-final-list">
                      {finalAgentMessages.map(summary => (
                        <li key={summary.turnId} className={`turn-drawer-final-item ${summary.turnId === activeFinalMessageTurn ? 'on' : ''}`}>
                          <button
                            type="button"
                            className="turn-drawer-final-row"
                            onClick={() => setActiveFinalMessageTurn(summary.turnId)}
                            title={summary.userMsg ?? `turn ${summary.turnId.slice(0, 6)}`}
                          >
                            <span className="turn-drawer-turn-time mono">{summary.time}</span>
                            <span className="turn-drawer-final-text">{truncateText(summary.text, 140)}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  ))}
                </section>

                <section className="turn-drawer-section" aria-labelledby="turn-drawer-changes-title">
                  <div className="turn-drawer-section-title" id="turn-drawer-changes-title">File changes</div>
                  {turns.length === 0 ? (
                    <div className="turn-drawer-section-empty">no file changes recorded yet</div>
                  ) : (
                    <ul className="turn-drawer-turn-list">
                      {turns.map(t => (
                        <li key={t.turnId} className={`turn-drawer-turn ${t.turnId === (turn?.turnId ?? '') ? 'on' : ''}`}>
                          <button
                            type="button"
                            className="turn-drawer-turn-row"
                            onClick={() => { setActiveFinalMessageTurn(null); setActiveTurn(t.turnId); setActiveFile(t.changes[0]?.path ?? null) }}
                          >
                            <span className="turn-drawer-turn-time mono">{t.time}</span>
                            <span className="turn-drawer-turn-summary">
                              {t.userMsg
                                ? truncateText(t.userMsg, 60)
                                : `turn ${t.turnId.slice(0, 6)}`}
                            </span>
                            <span className="turn-drawer-turn-count">{t.changes.length}</span>
                          </button>
                          {t.turnId === (turn?.turnId ?? '') && (
                            <ul className="turn-drawer-files">
                              {t.changes.map(c => (
                                <li
                                  key={c.path}
                                  className={`turn-drawer-file ${c.path === (change?.path ?? '') ? 'on' : ''}`}
                                >
                                  <button
                                    type="button"
                                    className="turn-drawer-file-row mono"
                                    onClick={() => { setActiveFinalMessageTurn(null); setActiveFile(c.path) }}
                                  >
                                    {c.path}
                                  </button>
                                </li>
                              ))}
                            </ul>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              </div>
              <div
                className="turn-drawer-list-resize"
                onMouseDown={onListHandleDown}
                title="drag to resize turns sidebar"
                role="separator"
                aria-orientation="vertical"
              />
            </>
          )}

          <div className="turn-drawer-diff">
            {activeFinalMessage ? (
              <article className="turn-drawer-message-pane">
                <header className="turn-drawer-message-head">
                  <span className="turn-drawer-message-kicker mono">{activeFinalMessage.time}</span>
                  <h3>Last agent message</h3>
                  {activeFinalMessage.userMsg && (
                    <p title={activeFinalMessage.userMsg}>In response to: {truncateText(activeFinalMessage.userMsg, 140)}</p>
                  )}
                </header>
                <pre className="turn-drawer-message-text">{activeFinalMessage.text}</pre>
              </article>
            ) : change
              ? <PierreDiff patch={change.patch} />
              : <div className="turn-drawer-empty">select a final message or file change</div>}
          </div>
        </div>
      )}
    </div>
  )
}
