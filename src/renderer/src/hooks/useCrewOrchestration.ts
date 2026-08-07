import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useCrewSession } from './useCrewSession'
import { useCrewSupervisor } from './useCrewSupervisor'
import { buildWorkerPreamble } from '../orchestrator/crew-supervisor-protocol'
import { promptDialog } from '../stores/dialog-service'
import {
  loadCrewTemplates,
  saveCrewTemplate,
  deleteCrewTemplate,
  type CrewTemplate,
} from '../orchestrator/crew-templates'
import {
  loadCrewRoles,
  saveCrewRole,
  updateCrewRole,
  deleteCrewRole,
  type CrewRole,
  type CrewRoleInput,
} from '../orchestrator/crew-roles'
import type {
  CrewGitDriver,
  CrewAgentLane,
  CrewSessionState,
  CrewLaneEffort,
  CrewRoleAssignment,
} from '../orchestrator/crew-session'
import type { AgentInfo, AgentProviderId, BridgeEvent, Message, Workspace } from '../types'
import type { EffortLevel } from '../components/composer/EffortPicker'

type SetMessagesForTab = (tabId: string, updater: (prev: Message[]) => Message[]) => void

/** Extract a lane's denormalized role fields back into an assignment for snapshots. */
function laneRole(l: CrewAgentLane): CrewRoleAssignment {
  return { roleId: l.roleId, roleName: l.roleName, role: l.role, instructions: l.instructions }
}

interface WorkspaceLike {
  // Mirrors the real useWorkspaces.createWorktree: a success carries the new
  // worktree (or null if it wasn't registered) alongside ok/path; failure sets
  // error. The crew git driver reads `worktree`/`error` and tolerates null.
  createWorktree: (wsId: string, branch: string, fromRef?: string) =>
    Promise<{ ok?: boolean; path?: string; worktree?: { id: string; path: string } | null; error?: string }>
  deleteWorktree: (wsId: string, worktreeId: string) => Promise<{ error?: string }>
}

interface BridgesLike {
  ensureBridge: (
    tabId: string,
    agentId: string,
    kind: AgentProviderId,
    cwd: string,
    model: string | undefined,
    effort: EffortLevel,
    mode?: 'ask' | 'plan' | 'build' | 'full',
    toolPolicy?: 'default' | 'read-only',
  ) => Promise<{ bridgeId: string } | { error: string }>
  prompt: (bridgeId: string, text: string, options?: { streamingBehavior?: 'followUp' }) => Promise<{ ok: boolean; error?: string }>
  abort: (bridgeId: string) => void
  dropBridge: (tabId: string, agentId: string) => void
  subscribeTurnEnd: (cb: (bridgeId: string, tabId: string) => void) => () => void
  subscribeActivity: (cb: (bridgeId: string, tabId: string, type: BridgeEvent['type']) => void) => () => void
}

// Loose view of a pty pane — `agentId` is `string | null` to match the real
// PtyPane (a null agentId marks a plain shell). `addAgent` returns this same
// shape so a freshly-created pane is non-undefined and `.paneId` is safe.
interface PtyPaneRef { tabId: string; agentId?: string | null; live?: boolean; paneId: string }

interface PtyLike {
  panes: PtyPaneRef[]
  addAgent: (wsId: string, tabId: string, agentId: string, name: string, cwd: string, shell?: string | null) => PtyPaneRef
  write: (paneId: string, text: string) => void
  close: (paneId: string) => void
}

export interface UseCrewOrchestrationOpts {
  activeWs: string
  activeTabId: string
  activeWorkspace: Workspace
  agents: AgentInfo[]
  effort: EffortLevel
  ws: WorkspaceLike
  bridges: BridgesLike
  pty: PtyLike
  setMessagesForTab: SetMessagesForTab
}

export function useCrewOrchestration(opts: UseCrewOrchestrationOpts) {
  const {
    activeWs, activeTabId, activeWorkspace, agents, effort,
    ws, bridges, pty, setMessagesForTab,
  } = opts

  // Effectful git layer for the crew state machine — provisions and removes the
  // per-lane worktrees over the existing worktree IPC.
  const crewGit: CrewGitDriver = useMemo(() => ({
    provisionLane: async (wsId, branch, fromRef) => {
      const r = await ws.createWorktree(wsId, branch, fromRef)
      if ('error' in r && r.error) return { error: r.error }
      if (!r.worktree)  return { error: 'worktree created but not registered' }
      return { worktreeId: r.worktree.id, path: r.worktree.path }
    },
    archiveLane: async (wsId, worktreeId) => {
      const r = await ws.deleteWorktree(wsId, worktreeId)
      return 'error' in r && r.error ? { error: r.error } : { ok: true }
    },
  }), [ws])

  // Runtime ids (bridgeId/paneId) that have already received their worker
  // priming preamble. A respawn yields a new id, so it naturally re-primes.
  const primedRuntimes = useRef<Set<string>>(new Set())

  // Stop a lane's agent before its worktree is removed — no orphaned processes.
  const releaseLane = useCallback((lane: CrewAgentLane) => {
    if (lane.bridgeId) window.electronAPI?.bridgeStop(lane.bridgeId)
    if (lane.paneId)   pty.close(lane.paneId)
  }, [pty])

  const crew = useCrewSession({ git: crewGit, onReleaseLane: releaseLane })
  const crewSession = activeTabId ? crew.sessions[activeTabId] ?? null : null

  // tab id → crew state, so the tab strip can mark tabs that host a crew.
  const crewTabs = useMemo(() => {
    const m: Record<string, CrewSessionState> = {}
    for (const [tabId, s] of Object.entries(crew.sessions)) m[tabId] = s.state
    return m
  }, [crew.sessions])

  const [crewEditingTab, setCrewEditingTab] = useState<string | null>(null)
  const crewEditing = !!crewSession && crewSession.state === 'active'
    && crewEditingTab === activeTabId

  const [crewDiffTab, setCrewDiffTab] = useState<string | null>(null)
  const crewDiffOpen = !!crewSession && crewSession.state === 'active'
    && crewDiffTab === activeTabId

  const [crewGitTab, setCrewGitTab] = useState<string | null>(null)
  const crewGitOpen = !!crewSession && crewSession.state === 'active'
    && crewGitTab === activeTabId

  const [rebuildConfirmOpen, setRebuildConfirmOpen] = useState(false)

  const [crewTemplates, setCrewTemplates] = useState<CrewTemplate[]>(() => loadCrewTemplates())

  // User-authored agent roles — global, reusable across workspaces.
  const [crewRoles, setCrewRoles] = useState<CrewRole[]>(() => loadCrewRoles())

  const handleSaveRole = useCallback((input: CrewRoleInput) => {
    const role = saveCrewRole(input)
    setCrewRoles(loadCrewRoles())
    return role
  }, [])

  const handleUpdateRole = useCallback((id: string, input: CrewRoleInput) => {
    updateCrewRole(id, input)
    setCrewRoles(loadCrewRoles())
  }, [])

  const handleDeleteRole = useCallback((id: string) => {
    deleteCrewRole(id)
    setCrewRoles(loadCrewRoles())
  }, [])

  const handleApplyTemplate = useCallback((tpl: CrewTemplate) => {
    if (!activeTabId || !crewSession || crewSession.state !== 'configuring') return
    crew.discard(activeTabId).then(() => {
      crew.begin({
        wsId:       crewSession.wsId,
        hostTabId:  activeTabId,
        basePath:   crewSession.basePath,
        baseBranch: crewSession.baseBranch,
        mode:       tpl.mode,
        worktrees:  crewSession.worktrees,
      })
      for (const l of tpl.lanes) crew.addLane(activeTabId, l.agentId, l.role, l.model, l.effort)
    })
  }, [activeTabId, crewSession, crew])

  const handleDeleteTemplate = useCallback((tplId: string) => {
    deleteCrewTemplate(tplId)
    setCrewTemplates(loadCrewTemplates())
  }, [])

  const handleSaveTemplate = useCallback(async () => {
    if (!crewSession) return
    const fallback = `${crewSession.mode} · ${crewSession.lanes.map(l => l.agentId).join('+')}`
    const name = await promptDialog({ title: 'Save crew template', label: 'template name', initial: fallback, confirmText: 'Save' })
    if (name === null) return
    saveCrewTemplate(name, crewSession.mode, crewSession.lanes.map(l => ({
      agentId: l.agentId, role: laneRole(l), model: l.model, effort: l.effort,
    })))
    setCrewTemplates(loadCrewTemplates())
  }, [crewSession])

  // A workspace supports worktrees only when it's a git repo (repo kind, or a
  // remote that reports a branch). A plain folder has none — isolated lanes then
  // run in-place in the base dir so the crew still works without git.
  const supportsWorktrees = activeWorkspace.kind === 'repo' || !!activeWorkspace.branch

  const startCrewForTab = useCallback((tabId: string) => {
    if (!activeWs || !tabId) return
    if (crew.sessions[tabId]) return
    crew.begin({
      wsId:       activeWs,
      hostTabId:  tabId,
      basePath:   activeWorkspace.path,
      baseBranch: activeWorkspace.branch ?? 'main',
      worktrees:  supportsWorktrees,
    })
  }, [activeWs, activeWorkspace, crew, supportsWorktrees])

  const handleStartCrew = useCallback(() => {
    if (!activeTabId) return
    startCrewForTab(activeTabId)
  }, [activeTabId, startCrewForTab])

  const handleRebuildCrew = useCallback(async () => {
    if (!activeTabId || !crewSession) return
    const snap = {
      wsId:       crewSession.wsId,
      basePath:   crewSession.basePath,
      baseBranch: crewSession.baseBranch,
      mode:       crewSession.mode,
      worktrees:  crewSession.worktrees,
      lanes:      crewSession.lanes.map(l => ({
        agentId: l.agentId, role: laneRole(l), model: l.model, effort: l.effort,
      })),
    }
    setCrewEditingTab(null)
    await crew.discard(activeTabId)
    crew.begin({
      wsId:       snap.wsId,
      hostTabId:  activeTabId,
      basePath:   snap.basePath,
      baseBranch: snap.baseBranch,
      mode:       snap.mode,
      worktrees:  snap.worktrees,
    })
    for (const l of snap.lanes) crew.addLane(activeTabId, l.agentId, l.role, l.model, l.effort)
  }, [activeTabId, crewSession, crew])

  // Once a crew goes active, give each lane a synthetic chat tab.
  useEffect(() => {
    if (!activeTabId || !crewSession || crewSession.state !== 'active') return
    for (const lane of crewSession.lanes) {
      if (lane.tabId) continue
      crew.bindLane(activeTabId, lane.laneId, { status: lane.status, tabId: `crew/${lane.laneId}` })
    }
  }, [activeTabId, crewSession, crew])

  // Live elapsed-time ticker for the lane usage strip.
  useEffect(() => {
    if (!crewSession || crewSession.state !== 'active') return
    const live = crewSession.lanes.filter(l => l.bridgeId || l.paneId)
    if (live.length === 0) return
    const tabId = activeTabId
    const interval = setInterval(() => {
      for (const lane of live) crew.addLaneUsage(tabId, lane.laneId, { elapsedMs: 1000 })
    }, 1000)
    return () => clearInterval(interval)
  }, [crewSession, activeTabId, crew])

  const sendToLanes = useCallback(async (tasks: Array<{ laneId: string; text: string }>): Promise<Array<{ laneId: string; started: boolean }>> => {
    if (!activeWs || !crewSession) return tasks.map(task => ({ laneId: task.laneId, started: false }))
    const time = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

    const prepared = await Promise.all(tasks.map(async (task) => {
      const lane = crewSession.lanes.find(l => l.laneId === task.laneId)
      if (!lane || !lane.tabId) return { ...task, started: false, error: 'lane is not ready' }
      const tabId = lane.tabId

      if (lane.muted) {
        setMessagesForTab(tabId, m => [...m, { kind: 'system', time, tone: 'info', text: `${lane.agentId} is skipped for this run — enable its model toggle before sending.` }])
        return { ...task, lane, tabId, started: false }
      }

      setMessagesForTab(tabId, m => [...m, { kind: 'user', text: task.text, time }])

      const agent = agents.find(a => a.id === lane.agentId && a.available)
      if (!agent) {
        setMessagesForTab(tabId, m => [...m, { kind: 'system', time, tone: 'error', text: `${lane.agentId} is unavailable` }])
        return { ...task, lane, tabId, started: false }
      }

      const primeText = (runtimeId: string, body: string): string => {
        if (primedRuntimes.current.has(runtimeId)) return body
        primedRuntimes.current.add(runtimeId)
        const pre = buildWorkerPreamble(lane, lane.path || crewSession.basePath)
        return pre ? `${pre}\n\n${body}` : body
      }

      if (agent.transport === 'bridge') {
        const r = await bridges.ensureBridge(
          tabId, agent.id, agent.id as AgentProviderId, lane.path, lane.model || undefined, lane.effort ?? effort,
        )
        if ('error' in r) {
          setMessagesForTab(tabId, m => [...m, { kind: 'system', time, tone: 'error', text: r.error }])
          return { ...task, lane, tabId, started: false }
        }
        crew.bindLane(activeTabId, lane.laneId, { status: 'running', tabId, bridgeId: r.bridgeId })
        return { ...task, lane, tabId, bridgeId: r.bridgeId, prompt: primeText(r.bridgeId, task.text), started: true }
      }

      let pane = pty.panes.find(p => p.tabId === tabId && p.agentId === agent.id && p.live)
      if (!pane) pane = pty.addAgent(activeWs, tabId, agent.id, agent.name, lane.path, agent.path)
      crew.bindLane(activeTabId, lane.laneId, { status: 'running', tabId, paneId: pane.paneId })
      return { ...task, lane, tabId, paneId: pane.paneId, prompt: primeText(pane.paneId, task.text), started: true }
    }))

    // All runtimes have been started/bound before any bridge prompt is submitted.
    // This prevents a slow provider turn (Claude SDK, etc.) from delaying another
    // worker's process startup in the same supervisor fan-out.
    for (const item of prepared) {
      if (!item.started) continue
      if ('bridgeId' in item && item.bridgeId && item.prompt) {
        void bridges.prompt(item.bridgeId, item.prompt).then(res => {
          if (!res.ok && item.tabId) {
            setMessagesForTab(item.tabId, m => [...m, { kind: 'system', time, tone: 'error', text: res.error ?? 'prompt failed' }])
          }
        }).catch(err => {
          if (item.tabId) setMessagesForTab(item.tabId, m => [...m, { kind: 'system', time, tone: 'error', text: (err as Error).message || 'prompt failed' }])
        })
      } else if ('paneId' in item && item.paneId && item.prompt) {
        pty.write(item.paneId, item.prompt + '\n')
      }
    }

    return prepared.map(item => ({ laneId: item.laneId, started: item.started }))
  }, [activeWs, activeTabId, crewSession, agents, bridges, crew, pty, effort, setMessagesForTab])

  // Returns true once a live runtime has been started and its prompt submitted.
  const sendToLane = useCallback(async (laneId: string, text: string): Promise<boolean> => {
    const [result] = await sendToLanes([{ laneId, text }])
    return result?.started === true
  }, [sendToLanes])

  const handleSetCrewName = useCallback((name: string) => {
    if (!activeTabId) return
    crew.setName(activeTabId, name)
  }, [activeTabId, crew])

  const handleSetLaneModel = useCallback((laneId: string, modelId: string) => {
    if (!activeTabId || !crewSession) return
    crew.setLaneModel(activeTabId, laneId, modelId)
    if (crewSession.state === 'active') {
      const lane = crewSession.lanes.find(l => l.laneId === laneId)
      if (!lane?.tabId) return
      const agent = agents.find(a => a.id === lane.agentId)
      if (agent?.transport === 'pty') {
        // pty agents bake the model into spawn argv, so the live process can't
        // adopt a new model — restart the lane and the next prompt respawns the
        // CLI with the new --model (mirrors the bridge dropBridge below).
        window.electronAPI?.ptyKill?.(lane.paneId ?? '')
        crew.restartLane(activeTabId, laneId)
      } else {
        bridges.dropBridge(lane.tabId, lane.agentId)
      }
    }
  }, [activeTabId, crewSession, crew, bridges, agents])

  const handleSetLaneEffort = useCallback((laneId: string, eff: CrewLaneEffort) => {
    if (!activeTabId || !crewSession) return
    crew.setLaneEffort(activeTabId, laneId, eff)
    if (crewSession.state === 'active') {
      const lane = crewSession.lanes.find(l => l.laneId === laneId)
      if (lane?.tabId) bridges.dropBridge(lane.tabId, lane.agentId)
    }
  }, [activeTabId, crewSession, crew, bridges])

  const handleSetLaneRole = useCallback((laneId: string, role: CrewRoleAssignment) => {
    if (!activeTabId || !crewSession) return
    crew.setLaneRole(activeTabId, laneId, role)
    // On a live crew the worker was already primed with the old role — respawn it
    // so the new role/instructions take on its next prompt (same as model/effort).
    if (crewSession.state === 'active') {
      const lane = crewSession.lanes.find(l => l.laneId === laneId)
      if (!lane?.tabId) return
      const agent = agents.find(a => a.id === lane.agentId)
      if (agent?.transport === 'pty') {
        window.electronAPI?.ptyKill?.(lane.paneId ?? '')
        crew.restartLane(activeTabId, laneId)
      } else {
        bridges.dropBridge(lane.tabId, lane.agentId)
      }
    }
  }, [activeTabId, crewSession, crew, bridges, agents])

  const handleRestartLane = useCallback((laneId: string) => {
    if (!activeTabId || !crewSession) return
    crew.restartLane(activeTabId, laneId)
  }, [activeTabId, crewSession, crew])

  const handleToggleLaneMute = useCallback((laneId: string) => {
    if (!activeTabId) return
    crew.toggleLaneMute(activeTabId, laneId)
  }, [activeTabId, crew])

  const handleBroadcast = useCallback((text: string) => {
    if (!crewSession) return
    crewSession.lanes
      .filter(l => !l.muted)
      // Direct broadcast must stay fire-and-track like supervisor fan-out; a
      // rejected lane prompt should not abort dispatch to the rest of the crew.
      .forEach(l => { void sendToLane(l.laneId, text).catch(() => {}) })
  }, [crewSession, sendToLane])

  // ── Supervisor layer ───────────────────────────────────────────────────────

  const { sendToSupervisor, abortSupervisor } = useCrewSupervisor({
    activeTabId,
    crewSession,
    agents,
    effort,
    bridges,
    crew,
    sendToLane,
    sendToLanes,
    setMessagesForTab,
  })

  const markTabStopped = useCallback((tabId: string) => {
    setMessagesForTab(tabId, messages => {
      let changed = false
      const next = messages.map(msg => {
        if (msg.kind === 'agent' && msg.streaming) {
          changed = true
          return { ...msg, streaming: false }
        }
        if (msg.kind === 'thinking' && msg.streaming) {
          changed = true
          return { ...msg, streaming: false }
        }
        if (msg.kind === 'toolcall' && (msg.status === 'pending' || msg.status === 'running')) {
          changed = true
          return { ...msg, status: 'error' as const, isError: true, result: 'stopped by user' }
        }
        return msg
      })
      return changed
        ? [...next, { kind: 'system' as const, tone: 'info' as const, text: 'request stopped', time: new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) }]
        : messages
    })
  }, [setMessagesForTab])

  // Hard-stop every running runtime in the crew: drop bridge workers so queued
  // replies are ignored immediately; terminal workers still receive Ctrl-C.
  const abortAll = useCallback(() => {
    if (!crewSession) return
    for (const lane of crewSession.lanes) {
      if (lane.bridgeId && lane.tabId) {
        markTabStopped(lane.tabId)
        bridges.dropBridge(lane.tabId, lane.agentId)
      } else if (lane.bridgeId) {
        bridges.abort(lane.bridgeId)
      }
      if (lane.paneId) pty.write(lane.paneId, '\x03')
    }
    abortSupervisor()
  }, [crewSession, bridges, pty, abortSupervisor, markTabStopped])

  const supervisorBridgeTab = useCallback(
    (s = crewSession) => s ? (s.supervisor.tabId ?? `crew/${s.id}/supervisor`) : null,
    [crewSession])

  const handleSetSupervisorEnabled = useCallback((enabled: boolean) => {
    if (!activeTabId || !crewSession) return
    crew.setSupervisorEnabled(activeTabId, enabled)
    // Disabling a live supervisor stops its bridge so no process lingers.
    if (!enabled && crewSession.supervisor.bridgeId) {
      const tab = supervisorBridgeTab()
      if (tab) bridges.dropBridge(tab, crewSession.supervisor.agentId)
    }
  }, [activeTabId, crewSession, crew, bridges, supervisorBridgeTab])

  const handleSetSupervisorAgent = useCallback((agentId: string) => {
    if (!activeTabId) return
    crew.setSupervisorAgent(activeTabId, agentId)
  }, [activeTabId, crew])

  const handleSetSupervisorModel = useCallback((model: string) => {
    if (!activeTabId || !crewSession) return
    crew.setSupervisorModel(activeTabId, model)
    // A live supervisor bakes the model into its bridge — respawn on next prompt.
    if (crewSession.state === 'active') {
      const tab = supervisorBridgeTab()
      if (tab) bridges.dropBridge(tab, crewSession.supervisor.agentId)
    }
  }, [activeTabId, crewSession, crew, bridges, supervisorBridgeTab])

  const handleSetSupervisorEffort = useCallback((eff: CrewLaneEffort) => {
    if (!activeTabId || !crewSession) return
    crew.setSupervisorEffort(activeTabId, eff)
    if (crewSession.state === 'active') {
      const tab = supervisorBridgeTab()
      if (tab) bridges.dropBridge(tab, crewSession.supervisor.agentId)
    }
  }, [activeTabId, crewSession, crew, bridges, supervisorBridgeTab])

  return {
    crew,
    crewSession,
    crewTabs,
    crewEditing,
    crewEditingTab,
    setCrewEditingTab,
    crewDiffOpen,
    crewDiffTab,
    setCrewDiffTab,
    crewGitOpen,
    crewGitTab,
    setCrewGitTab,
    rebuildConfirmOpen,
    setRebuildConfirmOpen,
    crewTemplates,
    handleApplyTemplate,
    handleDeleteTemplate,
    handleSaveTemplate,
    crewRoles,
    handleSaveRole,
    handleUpdateRole,
    handleDeleteRole,
    handleStartCrew,
    startCrewForTab,
    handleRebuildCrew,
    sendToLane,
    handleSetCrewName,
    handleSetLaneModel,
    handleSetLaneEffort,
    handleSetLaneRole,
    handleRestartLane,
    handleToggleLaneMute,
    handleBroadcast,
    abortAll,
    abortSupervisor,
    sendToSupervisor,
    handleSetSupervisorEnabled,
    handleSetSupervisorAgent,
    handleSetSupervisorModel,
    handleSetSupervisorEffort,
  }
}
