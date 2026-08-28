import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import { useMessagesStore } from '../../stores/chat-messages-store'
import { useMissionData, type MissionData, type UseMissionDataOpts } from './useMissionData'
import { MissionControl } from './MissionControl'
import { Menulet, MenuletTrigger } from './Menulet'
import { ActivityFeed } from './MCComponents'
import type { AgentUserResponse, Message } from '../../types'
import type { RegisteredPluginMissionWidget } from '../../../../shared/plugin-types'

// Mission data derives from chat state, but Control Center should not repaint
// for every streamed token. This host subscribes only to live/blocked edges.

const MissionDataContext = createContext<MissionData | null>(null)

function hasLiveTurn(messages: Message[]): boolean {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i]
    if (msg.kind === 'agent' && msg.streaming) return true
    if (msg.kind === 'thinking' && msg.streaming) return true
    if (msg.kind === 'toolcall' && (msg.status === 'running' || msg.status === 'pending')) return true
  }
  return false
}

function pendingApprovalToken(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i]
    if (msg.kind === 'toolcall' && msg.status === 'pending') return `${msg.toolName}:${msg.time ?? i}`
  }
  return ''
}

function missionScopeToken(messages: Message[]): string {
  return `${hasLiveTurn(messages) ? 'live' : 'idle'}:${pendingApprovalToken(messages)}`
}

function missionTokenByScope(messagesByTab: Record<string, Message[]>): Map<string, string> {
  return new Map(Object.entries(messagesByTab).map(([scope, messages]) => [scope, missionScopeToken(messages)]))
}

function useMissionMessagesByTab(): Record<string, Message[]> {
  const [initial] = useState(() => {
    const messagesByTab = useMessagesStore.getState().messagesByTab
    return { messagesByTab, tokenByScope: missionTokenByScope(messagesByTab) }
  })
  const [messagesByTab, setMessagesByTab] = useState(initial.messagesByTab)
  const tokenByScopeRef = useRef(initial.tokenByScope)

  useEffect(() => useMessagesStore.subscribe((state, prev) => {
    let changed = false
    const tokenByScope = tokenByScopeRef.current
    for (const scope in state.messagesByTab) {
      if (state.messagesByTab[scope] === prev.messagesByTab[scope]) continue
      const nextToken = missionScopeToken(state.messagesByTab[scope] ?? [])
      if (tokenByScope.get(scope) !== nextToken) changed = true
      tokenByScope.set(scope, nextToken)
    }
    for (const scope in prev.messagesByTab) {
      if (scope in state.messagesByTab) continue
      tokenByScope.delete(scope)
      changed = true
    }
    if (changed) setMessagesByTab(state.messagesByTab)
  }), [])

  return messagesByTab
}

// Real per-scope last-activity epochs from the on-disk transcript store. Message
// objects only carry a time-of-day string (no date), so these mtimes are the
// only reliable source for accurate multi-day "N ago" labels. Refetched whenever
// the mission message set changes (new activity → transcript rewritten).
function useScopeMtimes(refreshKey: unknown): Record<string, number> {
  const [mtimes, setMtimes] = useState<Record<string, number>>({})
  useEffect(() => {
    let cancelled = false
    window.electronAPI?.transcriptsMtimes?.()
      .then(m => { if (!cancelled) setMtimes(m ?? {}) })
      .catch(() => { /* store unavailable — fall back to message-time parsing */ })
    return () => { cancelled = true }
  }, [refreshKey])
  return mtimes
}

type ProviderProps = Omit<UseMissionDataOpts, 'messagesByTab' | 'scopeMtimes'> & { children: ReactNode }

export function MissionDataProvider({
  workspaces, crewSessions, chatSessions, agents, userRequestsByTab, isBridgeRunning, children,
}: ProviderProps) {
  // Mission Control needs status/blocked/completion changes immediately, not
  // every token. This keeps hidden chat streams from invalidating the shell.
  const messagesByTab = useMissionMessagesByTab()
  // Tool/approval tokens can change repeatedly inside one live turn. Mtimes only
  // need refreshing when scope membership or live→idle state changes.
  const mtimeRefreshKey = useMemo(() => Object.entries(messagesByTab)
    .map(([scope, messages]) => `${scope}:${hasLiveTurn(messages) ? 'live' : 'idle'}`)
    .sort()
    .join('|'), [messagesByTab])
  const scopeMtimes = useScopeMtimes(mtimeRefreshKey)
  const value = useMissionData({ workspaces, crewSessions, chatSessions, messagesByTab, scopeMtimes, agents, userRequestsByTab, isBridgeRunning })
  return <MissionDataContext.Provider value={value}>{children}</MissionDataContext.Provider>
}

function useMissionDataValue(): MissionData {
  const v = useContext(MissionDataContext)
  if (!v) throw new Error('useMissionDataValue must be used within MissionDataProvider')
  return v
}

interface McHandlers {
  onOpenAgent:   (mcAgentId: string) => void
  onPauseAgent:  (mcAgentId: string) => void
  onResumeAgent: (mcAgentId: string) => void
  onSpawnAgent:  () => void
  /** Answer an interactive agent request straight from MC / the menulet. */
  onRespondRequest?: (response: AgentUserResponse) => void | Promise<unknown>
}

interface MissionPluginProps {
  pluginMissionWidgets?: RegisteredPluginMissionWidget[]
  onPluginMissionWidget?: (target: { pluginId: string; sidebarPanel?: string; tab?: string; command?: string }) => void
}

/** Mission Control tab body — reads mission data from context, not App. */
export function MissionControlHost({ onOpenAgent, onPauseAgent, onResumeAgent, onSpawnAgent, onRespondRequest, pluginMissionWidgets = [], onPluginMissionWidget, onOpenActivity }: McHandlers & MissionPluginProps & { onOpenActivity?: () => void }) {
  const { agents, projects, feed } = useMissionDataValue()
  return (
    <MissionControl
      agents={agents}
      projects={projects}
      feed={feed}
      onOpenAgent={onOpenAgent}
      onPauseAgent={onPauseAgent}
      onResumeAgent={onResumeAgent}
      onSpawnAgent={onSpawnAgent}
      onRespondRequest={onRespondRequest}
      pluginMissionWidgets={pluginMissionWidgets}
      onPluginMissionWidget={onPluginMissionWidget}
      onOpenActivity={onOpenActivity}
    />
  )
}

interface MenuletHostProps extends McHandlers {
  open:        boolean
  onToggle:    () => void
  onClose:     () => void
  onOpenHub:   () => void
}

/**
 * Standalone activity feed for the mobile Mission Control sheet. Lives inside
 * the `MissionDataProvider` so it can read the same `feed` and `projects`
 * slice that the page consumes; the parent just drops it into a `MobileShell`
 * sheet via `useMobileShell().sheets['mission-activity']`.
 */
export function MissionActivitySheetHost() {
  const { feed, projects } = useMissionDataValue()
  return <ActivityFeed feed={feed} projects={projects} />
}

/** Menulet trigger + popover — reads live agent counts from context, not App. */
export function MenuletHost({
  open, onToggle, onClose, onOpenHub, onOpenAgent, onPauseAgent, onResumeAgent, onSpawnAgent, onRespondRequest,
}: MenuletHostProps) {
  const { agents, projects } = useMissionDataValue()
  const blockedCount = agents.filter((a) => a.status === 'blocked').length
  const runningCount = agents.filter((a) => a.status === 'running').length
  return (
    <>
      <MenuletTrigger blockedCount={blockedCount} runningCount={runningCount} onClick={onToggle} />
      <Menulet
        open={open}
        onClose={onClose}
        agents={agents}
        projects={projects}
        onOpenHub={onOpenHub}
        onOpenAgent={onOpenAgent}
        onPauseAgent={onPauseAgent}
        onResumeAgent={onResumeAgent}
        onSpawnAgent={onSpawnAgent}
        onRespondRequest={onRespondRequest}
      />
    </>
  )
}
