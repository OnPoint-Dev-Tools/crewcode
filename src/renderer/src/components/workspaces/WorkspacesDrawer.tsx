import React, { useEffect, useRef, useState } from 'react'
import { Icon, type IconName } from '../ui/Icon'
import { InputModal, type InputModalRequest } from '../ui/InputModal'
import { ConfirmModal, type ConfirmModalRequest } from '../ui/ConfirmModal'
import { WorkspaceRow } from './WorkspaceRow'
import { Sessions } from '../thread/Sessions'
import { formatElapsed, useNow } from '../thread/session-elapsed'
import { PROVIDER_IMAGES, providerImageClass } from '../composer/provider-meta'
import type { Session, TabKind, Workspace } from '../../types'
import { AgentActivityIndicator, type AgentActivityState } from '../ui/AgentActivityIndicator'
import type { AppMenuAction } from '../ui/AppMenu'
import { useUnreadByPane } from '../../stores/terminal-unread-store'
import { pointerEventCameFromWorkspaceDock } from './workspace-drawer-pointer-target'
import { hasWorkspaceFolderDestination } from './workspace-folder-menu'
import { delegatedSectionLabel, splitDelegatedSessions } from './delegated-session-split'
import { chatSessionSurface } from '../../hooks/chat-session-tab-owner'
import { workspaceDisplayPath } from './workspace-display-path'
import { isCompletedChatShortcutVisible } from './completed-chat-expiry'
import { pinnedSessionsFirst } from './pinned-session-order'

// App-tab feature list. Icons mirror the brand AppMenu so the two routes to
// these destinations read identically.
interface AppFeature {
  id:     string
  icon:   'workbench' | 'inspection' | 'crew' | 'code' | 'edit' | 'gitBranch' | 'plug' | 'monitor'
  label:  string
  desc:   string
  tab?:   TabKind          // set when the feature maps to a tab kind (for active state)
  action: AppMenuAction
}

const APP_FEATURES: AppFeature[] = [
  { id: 'mission', icon: 'monitor',    label: 'Control Center', desc: 'Overview of every session',   tab: 'mission',  action: { kind: 'open-tab', tab: 'mission' } },
  { id: 'canvas',  icon: 'workbench',    label: 'Workbench Mode',    desc: 'Open multiple chats and terminals together', tab: 'canvas', action: { kind: 'start-canvas' } },
  { id: 'git',     icon: 'gitBranch', label: 'Git Workspace',   desc: 'Review changes, commits, PRs, and worktrees', tab: 'git', action: { kind: 'open-tab', tab: 'git' } },
  { id: 'prompts', icon: 'inspection', label: 'Skills & Prompts Studio',          desc: 'Compose prompts & skills',    tab: 'prompts',  action: { kind: 'open-tab', tab: 'prompts' } },
  { id: 'crew',    icon: 'crew',    label: 'CrewCode Workers',     desc: 'Run agents in parallel with a Supervisor',                       action: { kind: 'start-crew' } },
  { id: 'writer',  icon: 'edit',    label: 'Writer Workspace', desc: 'Draft and revise content',    tab: 'writer',   action: { kind: 'open-tab', tab: 'writer' } },
  { id: 'code',    icon: 'code',    label: 'Code Editor',     desc: 'Browse & edit files',         tab: 'code',     action: { kind: 'open-tab', tab: 'code' } },
 { id: 'plugin',    icon: 'plug',    label: 'Plugins',     desc: 'Manage local-first extensions',         tab: 'plugin',     action: { kind: 'open-tab', tab: 'plugins' } },
]

// A chat session that finished an agent turn, flattened across every workspace
// for the drawer's "COMPLETED" section. App owns membership (only real turn-ends,
// minus dismissals), so this list is rendered as-is.
export interface WorkingChatEntry {
  sessionId: string
  tabId:     string
  wsId:      string
  label:     string
  wsName:    string
  agentId:   string
}

export interface CompletedChatEntry extends WorkingChatEntry {
  // Wall-clock ms of the last completed turn.
  completedAt: number
}

// A live CLI (claude, codex, …) running inside a terminal tab. Unread output
// counts are read from the terminal-unread store at render time (keyed by
// paneId) rather than baked into the entry, so streaming background panes don't
// re-render the App shell that builds this list.
export interface TerminalCliEntry {
  paneId:  string
  tabId:   string
  wsId:    string
  title:   string
  agentId: string
  wsName:  string
}

interface CtxMenuState {
  x:    number
  y:    number
  wsId: string
}

interface SessionCtxMenuState {
  x:       number
  y:       number
  session: Session
}

interface SectionProps {
  id:       string
  label:    string
  icon?:    IconName
  tone?:    'running' | 'completed'
  closed:   boolean
  onToggle: () => void
  children: React.ReactNode
}

function Section({ label, icon, tone, closed, onToggle, children }: SectionProps) {
  return (
    <>
      <button
        className={`ws-sec ws-sec-btn ws-sec-rule ${tone ? `ws-sec-${tone}` : ''}`}
        onClick={onToggle}
        aria-expanded={!closed}
      >
        <span
          className="ws-sec-chev"
          style={{ transform: closed ? 'rotate(0deg)' : 'rotate(90deg)', transition: 'transform 150ms ease' }}
        >
          <Icon name="chevRight" size={10} />
        </span>
        {icon && <Icon name={icon} size={10} />}
        <span className="ws-sec-text">{label}</span>
      </button>
      {!closed && children}
    </>
  )
}

interface WorkspacesDrawerProps {
  open:               boolean
  setOpen:            (o: boolean) => void
  height:             number
  width:              number
  position:           'bottom' | 'left' | 'right'
  active:             string
  setActive:          (id: string) => void
  density:            string
  workspaces:         Workspace[]
  sessionsByWorkspace?: Record<string, Session[]>
  activeSessionId?:     string
  onSessionActivate?:   (session: Session) => void
  onSessionAdd?:        (wsId: string) => void
  onSessionRemove?:     (session: Session) => void
  onSessionArchive?:    (session: Session) => void
  onSessionRename?:     (session: Session, label: string) => void
  onSessionTogglePin?:  (session: Session) => void
  onAddWorkspace?:    () => void
  onRemoveWorkspace?: (wsId: string) => void
  onTogglePin?:       (wsId: string, pinned: boolean) => void
  onRenameWorkspace?: (wsId: string, name: string) => void
  onSetFolder?:       (wsId: string, folder: string | null) => void
  onAppFeature?:      (action: AppMenuAction) => void
  activeKind?:        TabKind
  activeTabId?:          string
  workingChats?:         WorkingChatEntry[]
  completedChats?:       CompletedChatEntry[]
  terminalClis?:         TerminalCliEntry[]
  sessionCompletedAt?:   Record<string, number>
  workspaceAgentStatus?: Record<string, AgentActivityState | undefined>
  sessionAgentStatus?:   Record<string, AgentActivityState | undefined>
  onWorkingChatActivate?:   (entry: WorkingChatEntry) => void
  onCompletedChatActivate?: (entry: CompletedChatEntry) => void
  onTerminalCliActivate?:   (entry: TerminalCliEntry) => void
}

export function WorkspacesDrawer({
  open, setOpen, height, width, position, active, setActive, density,
  workspaces,
  sessionsByWorkspace = {},
  activeSessionId      = '',
  onSessionActivate    = () => {},
  onSessionAdd         = () => {},
  onSessionRemove,
  onSessionArchive,
  onSessionRename,
  onSessionTogglePin,
  onAddWorkspace     = () => {},
  onRemoveWorkspace,
  onTogglePin,
  onRenameWorkspace,
  onSetFolder,
  onAppFeature,
  activeKind,
  activeTabId           = '',
  workingChats          = [],
  completedChats        = [],
  terminalClis          = [],
  sessionCompletedAt    = {},
  workspaceAgentStatus  = {},
  sessionAgentStatus    = {},
  onWorkingChatActivate   = () => {},
  onCompletedChatActivate = () => {},
  onTerminalCliActivate   = () => {},
}: WorkspacesDrawerProps) {
  const [drawerTab,     setDrawerTab]     = useState<'workspaces' | 'app'>('workspaces')
  const [query,         setQuery]         = useState('')
  const [sectionClosed, setSectionClosed] = useState<Record<string, boolean>>({})
  const [modal,         setModal]         = useState<InputModalRequest | null>(null)
  const [confirm,       setConfirm]       = useState<ConfirmModalRequest | null>(null)
  const [ctxMenu,       setCtxMenu]       = useState<CtxMenuState | null>(null)
  const [ctxSub,        setCtxSub]        = useState<'folder' | null>(null)
  const [sessionCtx,    setSessionCtx]    = useState<SessionCtxMenuState | null>(null)
  const [homePath,      setHomePath]      = useState('')
  const drawerRef = useRef<HTMLDivElement>(null)
  // One shared ticking clock drives every elapsed badge in the drawer.
  const now = useNow()
  // Only this drawer re-renders on background terminal output, not the App shell.
  const unreadByPane = useUnreadByPane()

  useEffect(() => {
    window.electronAPI?.appHomePath().then(setHomePath).catch(() => setHomePath(''))
  }, [])

  // Click-outside-to-close — only for the bottom drawer, not the side sidebar.
  useEffect(() => {
    if (!open || position !== 'bottom') return
    const handle = (e: MouseEvent) => {
      const target = e.target
      // The dock's click owns toggling. Closing here on its earlier mousedown
      // would make the later click immediately reopen the drawer.
      if (pointerEventCameFromWorkspaceDock(e)) return
      if (drawerRef.current && !drawerRef.current.contains(target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [open, position, setOpen])

  useEffect(() => {
    if (!ctxMenu) return
    const close = () => { setCtxMenu(null); setCtxSub(null) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    window.addEventListener('click',   close)
    window.addEventListener('keydown', onKey)
    window.addEventListener('blur',    close)
    return () => {
      window.removeEventListener('click',   close)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('blur',    close)
    }
  }, [ctxMenu])

  useEffect(() => {
    if (!sessionCtx) return
    const close = () => setSessionCtx(null)
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    window.addEventListener('click',   close)
    window.addEventListener('keydown', onKey)
    window.addEventListener('blur',    close)
    return () => {
      window.removeEventListener('click',   close)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('blur',    close)
    }
  }, [sessionCtx])

  const filter = (list: Workspace[]) =>
    query
      ? list.filter(w => `${w.name} ${w.path} ${w.branch ?? ''} ${w.folder ?? ''}`.toLowerCase().includes(query.toLowerCase()))
      : list

  // Build folder map: { folderName -> workspaces[] } for unpinned workspaces.
  // Pinned workspaces always show in their own PINNED section regardless of folder.
  const visible = filter(workspaces)
  // Remote (ssh://) hosts get their own section, kept out of the local
  // pinned/folder/recent grouping so they read as a distinct class of project.
  const remote  = visible.filter(w => w.kind === 'remote')
  const local   = visible.filter(w => w.kind !== 'remote')
  const pinned  = local.filter(w => w.pinned)
  const rest    = local.filter(w => !w.pinned)
  // Pinned-first within REMOTE so pinning still surfaces a host to the top.
  const remoteSorted = [...remote].sort((a, b) => Number(b.pinned) - Number(a.pinned))

  const folderGroups = new Map<string, Workspace[]>()
  const unfiled: Workspace[] = []
  for (const w of rest) {
    if (w.folder) {
      const arr = folderGroups.get(w.folder) ?? []
      arr.push(w)
      folderGroups.set(w.folder, arr)
    } else {
      unfiled.push(w)
    }
  }
  const sortedFolders = [...folderGroups.keys()].sort((a, b) => a.localeCompare(b))

  // Known folder names across all workspaces (for "move to" menu).
  const knownFolders = [...new Set(workspaces.map(w => w.folder).filter((f): f is string => !!f))].sort()

  const isSide         = position !== 'bottom'

  function finishSessionAction() {
    if (isSide) return
    setOpen(false)
    // Bottom drawer overlays the composer; focus after it closes so typing resumes immediately.
    window.setTimeout(() => window.dispatchEvent(new CustomEvent('crewcode:focus-composer')), 60)
  }

  function openCtx(wsId: string, e: React.MouseEvent) {
    e.preventDefault()
    e.stopPropagation()
    const W = 220, H = 360
    const x = Math.min(e.clientX, window.innerWidth  - W - 8)
    const y = Math.min(e.clientY, window.innerHeight - H - 8)
    setCtxMenu({ x, y, wsId })
    setCtxSub(null)
  }

  function renameWorkspace(ws: Workspace) {
    setModal({
      title:       'Rename workspace',
      initial:     ws.name,
      confirmText: 'Rename',
      onConfirm:   (next) => { if (next !== ws.name) onRenameWorkspace?.(ws.id, next) }
    })
  }

  function renameFolder(oldName: string) {
    setModal({
      title:       `Rename folder "${oldName}"`,
      initial:     oldName,
      confirmText: 'Rename',
      onConfirm:   (next) => {
        if (next === oldName) return
        workspaces.filter(w => w.folder === oldName).forEach(w => onSetFolder?.(w.id, next))
      }
    })
  }

  function createFolder(wsId: string) {
    setModal({
      title:       'Create folder',
      label:       'Folder name',
      placeholder: 'folder name',
      confirmText: 'Create',
      onConfirm:   (name) => onSetFolder?.(wsId, name)
    })
  }

  function confirmDeleteSession(session: Session) {
    // In-app confirm (not native window.confirm, which freezes the composer's
    // focus under Electron/Wayland until reload).
    setConfirm({
      title:       `Delete "${session.label}"?`,
      body:        'This permanently removes the chat and its messages.',
      confirmText: 'Delete',
      danger:      true,
      onConfirm:   () => { onSessionRemove?.(session); finishSessionAction() },
    })
  }

  function renameSession(session: Session) {
    setModal({
      title:       'Rename chat',
      initial:     session.label,
      confirmText: 'Rename',
      onConfirm:   (next) => onSessionRename?.(session, next),
    })
  }

  function renderWorkspaceRow(ws: Workspace) {
    return (
      <div key={ws.id} className="ws-block">
        <div className="ws-row-wrap" onContextMenu={e => openCtx(ws.id, e)}>
          <WorkspaceRow
            ws={ws}
            active={ws.id === active}
            agentActivity={workspaceAgentStatus[ws.id]}
            displayPath={workspaceDisplayPath(ws.path, homePath)}
            onClick={() => setActive(ws.id)}
            onRename={onRenameWorkspace ? (name) => onRenameWorkspace(ws.id, name) : undefined}
          />
        </div>
      </div>
    )
  }

  function renderSelectedWorkspaceThreads() {
    const ws = workspaces.find(workspace => workspace.id === active)
    if (!ws) return null

    const wsSessions = sessionsByWorkspace[ws.id] ?? []
    // Agent-spawned threads stay grouped below the selected workspace's own
    // threads without expanding every workspace into a mixed hierarchy.
    const { own, delegated } = splitDelegatedSessions(wsSessions)
    // Pinning changes priority only inside the thread's existing provenance
    // group; stable partitioning preserves recency among peers.
    const ownSessions = pinnedSessionsFirst([...own].reverse())
    const delegatedSessions = pinnedSessionsFirst(delegated)
    const threadsKey = `threads:${ws.id}`
    const delegatedKey = `delegated:${ws.id}`
    const openSessionCtx = (list: Session[]) => (id: string, x: number, y: number) => {
      const session = list.find(s => s.id === id)
      if (!session) return
      const W = 200, H = 180
      setCtxMenu(null)
      setSessionCtx({
        x: Math.min(x, window.innerWidth  - W - 8),
        y: Math.min(y, window.innerHeight - H - 8),
        session,
      })
    }
    const activateSession = (id: string) => {
      const session = wsSessions.find(s => s.id === id)
      if (!session) return
      onSessionActivate(session)
      finishSessionAction()
    }
    const removeSession = onSessionRemove ? (id: string) => {
      const session = wsSessions.find(s => s.id === id)
      if (session) confirmDeleteSession(session)
    } : undefined

    return (
      <Section
        id={threadsKey}
        label={`THREADS · ${ws.name}`}
        icon="threads"
        closed={!!sectionClosed[threadsKey]}
        onToggle={() => setSectionClosed(prev => ({ ...prev, [threadsKey]: !prev[threadsKey] }))}
      >
        <div className="ws-session-list ws-selected-session-list">
          <Sessions
            sessions={ownSessions}
            active={activeSessionId}
            onActivate={activateSession}
            onAdd={() => {
              onSessionAdd(ws.id)
              finishSessionAction()
            }}
            onRemove={removeSession}
            onRowContextMenu={openSessionCtx(wsSessions)}
            sessionActivity={sessionAgentStatus}
            sessionCompletedAt={sessionCompletedAt}
            now={now}
          />
        </div>

        {delegatedSessions.length > 0 && (
          <Section
            id={delegatedKey}
            label={delegatedSectionLabel(delegatedSessions, id => wsSessions.find(s => s.id === id)?.label)}
            icon="listTree"
            closed={!!sectionClosed[delegatedKey]}
            onToggle={() => setSectionClosed(prev => ({ ...prev, [delegatedKey]: !prev[delegatedKey] }))}
          >
            {/* Delegated threads are ordinary sessions: same activation,
                rename, and delete paths, only visually set apart. */}
            <div className="ws-session-list ws-session-list-delegated">
              <Sessions
                sessions={delegatedSessions}
                active={activeSessionId}
                onActivate={activateSession}
                onRemove={removeSession}
                onRowContextMenu={openSessionCtx(wsSessions)}
                sessionActivity={sessionAgentStatus}
                sessionCompletedAt={sessionCompletedAt}
                now={now}
              />
            </div>
          </Section>
        )}
      </Section>
    )
  }

  return (
    <>
      <div
        ref={drawerRef}
        className={`ws-drawer ws-drawer-background ${isSide ? `side ${position}` : ''} ${open ? 'open' : ''}`}
        style={isSide ? ({ ['--ws-width' as string]: `${width}px` }) : { height }}
      >
        <div className={`ws-inner density-${density}`}>
          <div className="ws-head">
            <div className="ws-tabs" role="tablist">
              <button
                className={`ws-tab ${drawerTab === 'workspaces' ? 'on' : ''}`}
                role="tab"
                aria-selected={drawerTab === 'workspaces'}
                onClick={() => setDrawerTab('workspaces')}
              >
                <Icon name="projects" size={17} />WorkSpaces
              </button>
              <button
                className={`ws-tab ${drawerTab === 'app' ? 'on' : ''}`}
                role="tab"
                aria-selected={drawerTab === 'app'}
                onClick={() => setDrawerTab('app')}
              >
                <Icon name="app" size={16} />App
              </button>
            </div>
            {drawerTab === 'workspaces' && (
              <div className="ws-search">
                <Icon name="search" size={14} style={{ opacity: 0.5 }} />
                <input
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                  placeholder="search workspaces, repos, paths..."
                />
              </div>
            )}
            <div className="ws-actions">
              {drawerTab === 'workspaces' && (
                <button className="ws-action" onClick={onAddWorkspace}>
                  <Icon name="plus" size={12} />Create workspace
                </button>
              )}
            </div>
          </div>

          <div className="ws-list">
            {drawerTab === 'app' ? (
              <Section
                id="__features"
                label="FEATURES"
                icon="app"
                closed={!!sectionClosed['__features']}
                onToggle={() => setSectionClosed(p => ({ ...p, __features: !p['__features'] }))}
              >
                {APP_FEATURES.map(f => (
                  <div key={f.id} className="ws-block">
                    <div className="ws-row-wrap">
                      <button
                        className={`ws-row ${f.tab && f.tab === activeKind ? 'on' : ''}`}
                        onClick={() => onAppFeature?.(f.action)}
                      >
                        <span className="ws-kind"><Icon name={f.icon} size={14} /></span>
                        <span className="ws-main">
                          <span className="ws-name">{f.label}</span>
                          <span className="ws-path">{f.desc}</span>
                        </span>
                        <span className="ws-meta" />
                      </button>
                    </div>
                  </div>
                ))}
              </Section>
            ) : (
            <>
            {(() => {
              const q = query.toLowerCase()
              const working = q
                ? workingChats.filter(c => `${c.label} ${c.wsName} ${c.agentId}`.toLowerCase().includes(q))
                : workingChats
              const unexpiredChats = completedChats.filter(c =>
                isCompletedChatShortcutVisible(c.completedAt, now),
              )
              const chats = q
                ? unexpiredChats.filter(c => `${c.label} ${c.wsName} ${c.agentId}`.toLowerCase().includes(q))
                : unexpiredChats
              const clis = [...(q
                ? terminalClis.filter(t => `${t.title} ${t.wsName} ${t.agentId}`.toLowerCase().includes(q))
                : terminalClis)]
                .sort((a, b) => (unreadByPane[b.paneId] ?? 0) - (unreadByPane[a.paneId] ?? 0))
              return (
                <>
                  {working.length > 0 && (
                    <Section
                      id="__working_chats"
                      label="RUNNING"
                      icon="bolt"
                      tone="running"
                      closed={!!sectionClosed['__working_chats']}
                      onToggle={() => setSectionClosed(p => ({ ...p, __working_chats: !p['__working_chats'] }))}
                    >
                      {working.map(c => (
                        <div key={c.sessionId} className="ws-block">
                          <div className="ws-row-wrap">
                            <button
                              className={`ws-row ws-completed-row ws-running-row ${c.sessionId === activeSessionId ? 'on' : ''}`}
                              onClick={() => onWorkingChatActivate(c)}
                              title={`${c.label} · ${c.wsName}`}
                            >
                              <span className="ws-kind">
                                {PROVIDER_IMAGES[c.agentId] ? (
                                  <img
                                    src={PROVIDER_IMAGES[c.agentId]}
                                    alt={c.agentId}
                                    className={`ws-provider-img ${providerImageClass(c.agentId)}`}
                                    width={14}
                                    height={14}
                                  />
                                ) : (
                                  <Icon name="chat" size={14} />
                                )}
                              </span>
                              <span className="ws-main">
                                <span className="ws-name">
                                  {c.label}
                                  {chatSessionSurface(c.tabId) === 'writer' && (
                                    <span className="sess-surface" aria-label="Writers Workspace chat">
                                      <Icon name="edit" size={9} />writer
                                    </span>
                                  )}
                                </span>
                                <span className="ws-path">{c.wsName} · {c.agentId}</span>
                              </span>
                              <span className="ws-meta">
                                <AgentActivityIndicator state="working" size={12} />
                              </span>
                            </button>
                          </div>
                        </div>
                      ))}
                    </Section>
                  )}
                 {chats.length > 0 && (
                    <Section
                      id="__recent_chats"
                      label="COMPLETED"
                      icon="check"
                      tone="completed"
                      closed={!!sectionClosed['__recent_chats']}
                      onToggle={() => setSectionClosed(p => ({ ...p, __recent_chats: !p['__recent_chats'] }))}
                    >
                      {chats.map(c => (
                        <div key={c.sessionId} className="ws-block">
                          <div className="ws-row-wrap">
                            <button
                              className={`ws-row ws-completed-row ${c.sessionId === activeSessionId ? 'on' : ''}`}
                              // App dismisses it from Completed (persisted) and
                              // activates it; it returns on the next turn end.
                              onClick={() => onCompletedChatActivate(c)}
                              title={`${c.label} · ${c.wsName}`}
                            >
                              <span className="ws-kind">
                                {PROVIDER_IMAGES[c.agentId] ? (
                                  <img
                                    src={PROVIDER_IMAGES[c.agentId]}
                                    alt={c.agentId}
                                    className={`ws-provider-img ${providerImageClass(c.agentId)}`}
                                    width={14}
                                    height={14}
                                  />
                                ) : (
                                  <Icon name="chat" size={14} />
                                )}
                              </span>
                              <span className="ws-main">
                                <span className="ws-name">
                                  {c.label}
                                  {chatSessionSurface(c.tabId) === 'writer' && (
                                    <span className="sess-surface" aria-label="Writers Workspace chat">
                                      <Icon name="edit" size={9} />writer
                                    </span>
                                  )}
                                </span>
                                <span className="ws-path">{c.wsName} · {c.agentId}</span>
                              </span>
                              <span className="ws-meta">
                                {sessionAgentStatus[c.sessionId] && (
                                  <AgentActivityIndicator state={sessionAgentStatus[c.sessionId]} size={12} />
                                )}
                                {c.completedAt && (
                                  <span className="ws-elapsed" title="completed">
                                    {formatElapsed(now - c.completedAt)}
                                  </span>
                                )}
                              </span>
                            </button>
                          </div>
                        </div>
                      ))}
                    </Section>
                  )}
                  {clis.length > 0 && (
                    <Section
                      id="__terminals"
                      label="TERMINALS"
                      icon="terminal"
                      closed={!!sectionClosed['__terminals']}
                      onToggle={() => setSectionClosed(p => ({ ...p, __terminals: !p['__terminals'] }))}
                    >
                      {clis.map(t => (
                        <div key={t.paneId} className="ws-block">
                          <div className="ws-row-wrap">
                            <button
                              className={`ws-row ${t.tabId === activeTabId ? 'on' : ''}`}
                              onClick={() => onTerminalCliActivate(t)}
                              title={`${t.title} · ${t.wsName}`}
                            >
                              <span className="ws-kind"><Icon name="terminal" size={14} /></span>
                              <span className="ws-main">
                                <span className="ws-name">
                                  {t.title}
                                  {(unreadByPane[t.paneId] ?? 0) > 0 && (
                                    <span className="ws-unread" aria-label={`${unreadByPane[t.paneId]} unread`}>
                                      {(unreadByPane[t.paneId] ?? 0) > 9 ? '9+' : unreadByPane[t.paneId]}
                                    </span>
                                  )}
                                </span>
                                <span className="ws-path">{t.wsName} · {t.agentId}</span>
                              </span>
                              <span className="ws-meta" />
                            </button>
                          </div>
                        </div>
                      ))}
                    </Section>
                  )}
                </>
              )
            })()}
            {pinned.length > 0 && (
              <Section
                id="__pinned"
                label="PINNED"
                icon="pin"
                closed={!!sectionClosed['__pinned']}
                onToggle={() => setSectionClosed(p => ({ ...p, __pinned: !p['__pinned'] }))}
              >
                {pinned.map(ws => renderWorkspaceRow(ws))}
              </Section>
            )}
            {sortedFolders.map(folder => (
              <Section
                key={folder}
                id={`folder:${folder}`}
                label={folder.toUpperCase()}
                icon="folder"
                closed={!!sectionClosed[`folder:${folder}`]}
                onToggle={() => setSectionClosed(p => ({ ...p, [`folder:${folder}`]: !p[`folder:${folder}`] }))}
              >
                {folderGroups.get(folder)!.map(ws => renderWorkspaceRow(ws))}
              </Section>
            ))}
            {unfiled.length > 0 && (
              <Section
                id="__recent"
                label="PROJECTS"
                icon="projects"
                closed={!!sectionClosed['__recent']}
                onToggle={() => setSectionClosed(p => ({ ...p, __recent: !p['__recent'] }))}
              >
                {unfiled.map(ws => renderWorkspaceRow(ws))}
              </Section>
            )}
            {remoteSorted.length > 0 && (
              <Section
                id="__remote"
                label="REMOTE"
                icon="globe"
                closed={!!sectionClosed['__remote']}
                onToggle={() => setSectionClosed(p => ({ ...p, __remote: !p['__remote'] }))}
              >
                {remoteSorted.map(ws => renderWorkspaceRow(ws))}
              </Section>
            )}
            {workspaces.length === 0 && (
              <div className="ws-empty">
                no workspaces yet — click <b>Add folder</b> to incorporate a repo or local folder
              </div>
            )}
            {workspaces.length > 0 && visible.length === 0 && (
              <div className="ws-empty">no workspaces match "{query}"</div>
            )}
            {renderSelectedWorkspaceThreads()}
            </>
            )}
          </div>
        </div>
      </div>

      {ctxMenu && (() => {
        const ws = workspaces.find(w => w.id === ctxMenu.wsId)
        if (!ws) return null
        const canMoveToFolder = hasWorkspaceFolderDestination(knownFolders, ws.folder)

        return (
          <div
            className="ws-ctx-menu"
            style={{ left: ctxMenu.x, top: ctxMenu.y }}
            onClick={e => e.stopPropagation()}
            onContextMenu={e => e.preventDefault()}
          >
            {ctxSub === 'folder' ? (
              <>
                <div className="ws-ctx-section">move to folder</div>
                <div className="ws-ctx-sub">
                  <button
                    className="ws-ctx-mi"
                    onClick={() => { onSetFolder?.(ws.id, null); setCtxMenu(null) }}
                  >
                    (no folder)
                  </button>
                  {knownFolders.filter(f => f !== ws.folder).map(f => (
                    <button
                      key={f}
                      className="ws-ctx-mi"
                      onClick={() => { onSetFolder?.(ws.id, f); setCtxMenu(null) }}
                    >
                      <Icon name="folder" size={11} /> {f}
                    </button>
                  ))}
                </div>
                <div className="ws-ctx-sep" />
                <button className="ws-ctx-mi" onClick={() => setCtxSub(null)}>← back</button>
              </>
            ) : (
              <>
                <div className="ws-ctx-section">{ws.name}</div>
                {onTogglePin && (
                  <button
                    className="ws-ctx-mi"
                    onClick={() => { onTogglePin(ws.id, !ws.pinned); setCtxMenu(null) }}
                  >
                    <Icon name="pin" size={11} /> {ws.pinned ? 'Unpin workspace' : 'Pin workspace'}
                  </button>
                )}
                {onRenameWorkspace && (
                  <button
                    className="ws-ctx-mi"
                    onClick={() => { renameWorkspace(ws); setCtxMenu(null) }}
                  >
                    <Icon name="edit" size={11} /> Rename workspace
                  </button>
                )}
                {onSetFolder && (
                  <button
                    className="ws-ctx-mi"
                    onClick={() => { createFolder(ws.id); setCtxMenu(null) }}
                  >
                    <Icon name="plus" size={11} /> Create folder…
                  </button>
                )}
                {onSetFolder && canMoveToFolder && (
                  <button
                    className="ws-ctx-mi"
                    onClick={() => setCtxSub('folder')}
                  >
                    <Icon name="folder" size={11} /> Move to folder…
                  </button>
                )}
                {onSetFolder && ws.folder && (
                  <button
                    className="ws-ctx-mi"
                    onClick={() => { renameFolder(ws.folder!); setCtxMenu(null) }}
                  >
                    <Icon name="edit" size={11} /> Rename folder "{ws.folder}"
                  </button>
                )}
                {onSetFolder && ws.folder && (
                  <button
                    className="ws-ctx-mi"
                    onClick={() => { onSetFolder(ws.id, null); setCtxMenu(null) }}
                  >
                    <Icon name="close" size={11} /> Remove from folder
                  </button>
                )}
                {onRemoveWorkspace && (
                  <>
                    <div className="ws-ctx-sep" />
                    <button
                      className="ws-ctx-mi danger"
                      onClick={() => { onRemoveWorkspace(ws.id); setCtxMenu(null) }}
                    >
                      <Icon name="close" size={11} /> Remove workspace
                    </button>
                  </>
                )}
              </>
            )}
          </div>
        )
      })()}

      {sessionCtx && (() => {
        const session = sessionCtx.session
        return (
          <div
            className="ws-ctx-menu"
            style={{ left: sessionCtx.x, top: sessionCtx.y }}
            onClick={e => e.stopPropagation()}
            onContextMenu={e => e.preventDefault()}
          >
            <div className="ws-ctx-section">{session.label}</div>
            {onSessionTogglePin && (
              <button
                className="ws-ctx-mi"
                onClick={() => { onSessionTogglePin(session); setSessionCtx(null) }}
              >
                <Icon name="pin" size={11} /> {session.pinned ? 'Unpin chat' : 'Pin chat'}
              </button>
            )}
            {onSessionRename && (
              <button
                className="ws-ctx-mi"
                onClick={() => { renameSession(session); setSessionCtx(null) }}
              >
                <Icon name="edit" size={11} /> Rename chat
              </button>
            )}
            {onSessionArchive && (
              <button
                className="ws-ctx-mi"
                onClick={() => { onSessionArchive(session); setSessionCtx(null) }}
              >
                <Icon name="archive" size={11} /> Archive chat
              </button>
            )}
            {onSessionRemove && (
              <>
                <div className="ws-ctx-sep" />
                <button
                  className="ws-ctx-mi danger"
                  onClick={() => { setSessionCtx(null); confirmDeleteSession(session) }}
                >
                  <Icon name="trash" size={11} /> Delete chat
                </button>
              </>
            )}
          </div>
        )
      })()}

      <InputModal request={modal} onClose={() => setModal(null)} />
      <ConfirmModal request={confirm} onClose={() => setConfirm(null)} />
    </>
  )
}
