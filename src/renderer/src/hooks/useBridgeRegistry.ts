/**
 * useBridgeRegistry — owns the agent-bridge lifecycle: the (tab,agent)→bridge
 * map, bridge creation, and teardown. Wraps useAgentBridge for event routing.
 *
 * Extracted from App so a tab close, a model switch, and (next) the crew layout
 * all drive bridge teardown through one place instead of poking raw maps.
 */

import { useState, useEffect, useRef, useCallback } from 'react'

import { useAgentBridge } from './useAgentBridge'
import { bridgeActivity, useRunningByBridge, useRunningByScope } from '../stores/bridge-activity-store'
import { getCrewCodeRuntime } from '../runtime/crewcode-client'
import { claimedWebBridgeRoutes, forgetWebBridgeRoute, rememberWebBridgeRoutes, webBridgeRoutes } from '../runtime/web-bridge-routes'
import type { AgentProviderId, AgentUserResponse, BridgeEvent, ChatPromptOptions, Message, ModeLevel } from '../types'
import type { EffortLevel } from '../components/composer/EffortPicker'
import type { McpServerConfig } from './useSettings'
import type { CrewCoderMode } from '../../../shared/crewcoder-types'

type BridgeToolPolicy = 'default' | 'read-only'

function isWebRuntime(): boolean {
  try { return getCrewCodeRuntime().kind === 'web' } catch { return false }
}

export function bridgeRuntimeId(tabId: string, agentId: string, web: boolean, at = Date.now()): string {
  return web ? `br-${tabId}-${agentId}-remote` : `br-${tabId}-${agentId}-${at.toString(36)}`
}

interface UseBridgeRegistryOpts {
  setMessagesForTab: (tabId: string, updater: (prev: Message[]) => Message[]) => void
}

export function useBridgeRegistry({ setMessagesForTab }: UseBridgeRegistryOpts) {
  // Runtime kind is immutable for the life of this mounted application. Capture
  // it once so page teardown cannot accidentally fall through to desktop stop
  // behavior if another parent cleanup has already dismantled web runtime state.
  const webRuntime = useRef(isWebRuntime()).current
  // "tabId:agentId" → bridgeId, and the reverse bridgeId → tabId for routing.
  const recoveredRoutes = useRef(webRuntime ? webBridgeRoutes() : []).current
  const claimedRoutes = useRef(webRuntime ? claimedWebBridgeRoutes() : []).current
  const [bridgesByKey, setBridgesByKey] = useState<Record<string, string>>(() => Object.fromEntries(
    claimedRoutes.filter(route => route.provider).map(route => [`${route.tabId}:${route.provider}`, route.bridgeId]),
  ))
  const [bridgeToTab,  setBridgeToTab]  = useState<Record<string, string>>(() => Object.fromEntries(recoveredRoutes.map(route => [route.bridgeId, route.tabId])))
  // bridgeId → cwd, so the bridge event hook can read pre/post file snapshots
  // for the per-turn change tracker.
  const [bridgeToCwd,  setBridgeToCwd]  = useState<Record<string, string>>(() => Object.fromEntries(recoveredRoutes.filter(route => route.cwd).map(route => [route.bridgeId, route.cwd!])))
  // bridgeId → mode that was in effect when the bridge was spawned. Used to
  // tag streamed agent bubbles so Plan-mode replies get the format toggle.
  const [bridgeToMode, setBridgeToMode] = useState<Record<string, ModeLevel>>({})
  // Running / status / follow-ups / pending requests live in bridge-activity-store
  // so each surface subscribes to what it reads instead of depending on this
  // hook's return object churning. We subscribe to `runningByBridge` here only
  // because `isBridgeRunning` feeds the workspaces drawer and Mission Control;
  // status and follow-up churn deliberately does NOT re-render App.
  const runningByBridge = useRunningByBridge()
  const runningByScope = useRunningByScope()
  const startingBridgeIdsRef = useRef(new Set<string>())
  const bridgesByKeyRef = useRef(bridgesByKey)
  bridgesByKeyRef.current = bridgesByKey
  useEffect(() => {
    for (const route of recoveredRoutes) bridgeActivity.bindScope(route.bridgeId, route.tabId)
  }, [recoveredRoutes])

  // Turn-end fan-out — the crew Supervisor subscribes here to relay worker
  // replies. A plain Set of listeners keeps this independent of React state.
  const turnEndListeners = useRef(new Set<(bridgeId: string, tabId: string, turnId?: string) => void>())
  const subscribeTurnEnd = useCallback((cb: (bridgeId: string, tabId: string, turnId?: string) => void) => {
    turnEndListeners.current.add(cb)
    return () => { turnEndListeners.current.delete(cb) }
  }, [])

  // Liveness heartbeat fan-out — the Supervisor's idle watchdog subscribes here.
  type ActivityCb = (bridgeId: string, tabId: string, type: BridgeEvent['type']) => void
  const activityListeners = useRef(new Set<ActivityCb>())
  const subscribeActivity = useCallback((cb: ActivityCb) => {
    activityListeners.current.add(cb)
    return () => { activityListeners.current.delete(cb) }
  }, [])

  const bridge = useAgentBridge({
    setMessagesForTab,
    bridgeToTab,
    bridgeToCwd,
    bridgeToMode,
    onTurnEnd: (bridgeId, tabId, turnId) => {
      for (const cb of turnEndListeners.current) cb(bridgeId, tabId, turnId)
    },
    onActivity: (bridgeId, tabId, type) => {
      for (const cb of activityListeners.current) cb(bridgeId, tabId, type)
    },
    onStatus: (bridgeId, message) => {
      bridgeActivity.setStatus(bridgeId, message || null)
    },
    onUserRequest: (tabId, request) => {
      bridgeActivity.addUserRequest(tabId, request)
    },
    onUserRequestResolved: (tabId, requestId) => {
      bridgeActivity.removeUserRequest(tabId, requestId)
    },
    onFollowUpQueued: (bridgeId, followUpId, text) => {
      bridgeActivity.addFollowUp(bridgeId, followUpId, text)
    },
    onFollowUpRemoved: (bridgeId, followUpId) => {
      bridgeActivity.removeFollowUp(bridgeId, followUpId)
    },
    onRunningChange: (bridgeId, running) => {
      const scopeId = bridgeToTab[bridgeId]
      if (scopeId) bridgeActivity.bindScope(bridgeId, scopeId)
      if (!running) {
        // A settled turn can't still be blocked on a prompt, and its transient
        // startup/resume status is stale.
        bridgeActivity.setStatus(bridgeId, null)
        bridgeActivity.removeRequestsForBridge(bridgeId)
      }
      bridgeActivity.setRunning(bridgeId, running)
    },
    // Idle sweep freed the process — forget every map entry for this bridge so
    // the next ensureBridge starts a fresh (resuming) one instead of returning
    // the dead id. The (tab,agent) key is found by reverse-looking-up the id.
    onReleased: (bridgeId) => {
      setBridgesByKey(prev => {
        let hit = false
        const next = { ...prev }
        for (const k of Object.keys(next)) if (next[k] === bridgeId) { delete next[k]; hit = true }
        return hit ? next : prev
      })
      setBridgeToTab(prev => { if (!(bridgeId in prev)) return prev; const n = { ...prev }; delete n[bridgeId]; return n })
      setBridgeToCwd(prev => { if (!(bridgeId in prev)) return prev; const n = { ...prev }; delete n[bridgeId]; return n })
      setBridgeToMode(prev => { if (!(bridgeId in prev)) return prev; const n = { ...prev }; delete n[bridgeId]; return n })
      bridgeActivity.clearBridges([bridgeId])
    },
    // An execution-custody invariant tripped. Main already contained the
    // process and preserved the evidence; the halt is recorded here so the
    // chat pane can refuse to look like nothing happened.
    onCustodyHalt: (tabId, _bridgeId, halt) => {
      bridgeActivity.setCustodyHalt(tabId, halt)
    },
    onCustodyCleared: (_tabId, scopeKey) => {
      bridgeActivity.clearCustodyHaltsForScope(scopeKey)
    },
  })

  const respondUserRequest = useCallback(async (response: AgentUserResponse) => {
    const result = await window.electronAPI?.bridgeRespondUserRequest?.(response)
      ?? { error: 'electronAPI unavailable' }
    if (!result.error) bridgeActivity.removeUserRequestById(response.requestId)
    return result
  }, [])

  // Stop every bridge when the app tears down. A ref keeps the cleanup reading
  // the live map without re-running on each bridge change.
  const liveRef = useRef<Record<string, string>>({})
  liveRef.current = bridgesByKey
  useEffect(() => () => {
    // Closing a remote browser detaches from Brain-owned executions. Explicit
    // tab/session removal still calls bridge.stop, but page teardown must not
    // turn a temporary network lifecycle into an execution lifecycle.
    if (webRuntime) return
    for (const id of Object.values(liveRef.current)) window.electronAPI?.bridgeStop(id)
  }, [webRuntime])

  /**
   * Return the bridge for (tabId, agentId), starting one if none exists.
   * Registers the maps before `start` so streamed events route immediately,
   * and rolls them back if `start` fails.
   */
  const ensureBridge = useCallback(async (
    tabId:    string,
    agentId:  string,
    provider: AgentProviderId,
    cwd:      string,
    model?:   string,
    effort?:  EffortLevel,
    mode?:    ModeLevel,
    toolPolicy?: BridgeToolPolicy,
    // Force a brand-new bridge even if one is cached — used to self-heal a
    // cached id whose process main no longer has (agent crash / stale cache).
    force = false,
    // MCP servers this session opted into. Attached to the upstream session at
    // start (providers that support it); ignored by the rest.
    mcpServers?: McpServerConfig[],
    // Provider handoff starts a fresh native session and seeds summary context.
    freshSession = false,
    externalDirectories?: string[],
    crewcoderMode?: CrewCoderMode,
  ): Promise<{ bridgeId: string } | { error: string }> => {
    const key      = `${tabId}:${agentId}`
    const existing = bridgesByKey[key]
    const forceFresh = force || freshSession
    if (existing && !forceFresh) {
      bridgeActivity.bindScope(existing, tabId)
      if (webRuntime) {
        // Reassert the stable bridge before each explicit web prompt. Brain
        // treats this as an idempotent attach while the execution exists; if
        // Brain restarted and lost its process-local owner map, it creates the
        // replacement bridge instead. The interrupted prompt is never replayed.
        bridge.registerRoute(existing, tabId, cwd, mode)
        const attached = await bridge.start(existing, provider, cwd, model, mode, effort, toolPolicy, key, tabId, mcpServers, false, externalDirectories, crewcoderMode)
        if (attached.custodyHalt) bridgeActivity.setCustodyHalt(tabId, attached.custodyHalt)
        if (attached.error) return { error: attached.error }
      }
      if (mode) {
        setBridgeToMode(prev => prev[existing] === mode ? prev : { ...prev, [existing]: mode })
        bridge.setMode(existing, mode)
      }
      return { bridgeId: existing }
    }
    // A stale-id self-heal carries the accepted user request into the replacement
    // runtime. Preserve its pending activity instead of recording an interruption.
    if (existing && forceFresh) bridge.stop(existing, true)

    // A stable remote id lets a newly authenticated browser runtime explicitly
    // reclaim the same Brain-side execution without replaying its start/prompt.
    const bridgeId = bridgeRuntimeId(tabId, agentId, webRuntime)
    // React may batch the state updates below until after bridge.start has
    // already emitted ready/turn/text events. Install routing synchronously so
    // a fast remote provider cannot complete into an unmapped event sink.
    bridge.registerRoute(bridgeId, tabId, cwd, mode)
    if (webRuntime) rememberWebBridgeRoutes([{ bridgeId, tabId, cwd, provider }])
    setBridgeToTab(prev => ({ ...prev, [bridgeId]: tabId }))
    setBridgeToCwd(prev => ({ ...prev, [bridgeId]: cwd }))
    if (mode) setBridgeToMode(prev => ({ ...prev, [bridgeId]: mode }))
    setBridgesByKey(prev => ({ ...prev, [key]: bridgeId }))
    bridgesByKeyRef.current = { ...bridgesByKeyRef.current, [key]: bridgeId }
    // Bind the conversation scope before flipping Running so the workspace
    // drawer can list this chat immediately — including ACP providers that
    // acknowledge prompt() before the turn finishes.
    bridgeActivity.bindScope(bridgeId, tabId)
    // Navigation can unmount the chat surface while bridge:start is still in
    // flight. Treat startup as protected so cleanup/pruning cannot abort it.
    startingBridgeIdsRef.current.add(bridgeId)
    bridgeActivity.setRunning(bridgeId, true)

    // Native resume ids stay provider-specific via `key`; local replay history
    // is session-scoped so switching providers can continue the same thread.
    const r = await bridge.start(bridgeId, provider, cwd, model, mode, effort, toolPolicy, key, tabId, mcpServers, freshSession, externalDirectories, crewcoderMode)
    startingBridgeIdsRef.current.delete(bridgeId)
    // A halt in force refuses the start outright, so no process was spawned.
    // Record it here, where the tab is known synchronously.
    if (r.custodyHalt) bridgeActivity.setCustodyHalt(tabId, r.custodyHalt)
    if (r.error) {
      setBridgesByKey(prev => { const n = { ...prev }; delete n[key]; return n })
      setBridgeToTab(prev => { const n = { ...prev }; delete n[bridgeId]; return n })
      setBridgeToCwd(prev => { const n = { ...prev }; delete n[bridgeId]; return n })
      setBridgeToMode(prev => { const n = { ...prev }; delete n[bridgeId]; return n })
      bridgeActivity.clearBridges([bridgeId])
      if (webRuntime) forgetWebBridgeRoute(bridgeId)
      return { error: r.error }
    }
    return { bridgeId }
  }, [bridge, bridgesByKey, webRuntime])

  /** Stop and forget one bridge — used when model/effort change forces a respawn. */
  const dropBridge = useCallback((tabId: string, agentId: string) => {
    const key = `${tabId}:${agentId}`
    const id  = bridgesByKey[key]
    if (!id) return
    bridge.stop(id)
    setBridgesByKey(prev => { const n = { ...prev }; delete n[key]; return n })
    setBridgeToTab(prev => { const n = { ...prev }; delete n[id]; return n })
    setBridgeToCwd(prev => { const n = { ...prev }; delete n[id]; return n })
    setBridgeToMode(prev => { const n = { ...prev }; delete n[id]; return n })
    bridgeActivity.clearBridges([id])
    bridgeActivity.clearTabRequests(tabId)
  }, [bridge, bridgesByKey])

  /** Stop and forget bridges for a tab. In-flight bridges are preserved unless explicitly forced. */
  // Stop and forget every bridge whose key matches `match`, then purge its
  // registry/activity state. Bridge keys are `${scopeId}:${agentId}` — see the
  // two callers below for the difference between tab-prefix and exact-scope.
  const releaseBridgesWhere = useCallback((match: (key: string) => boolean, stopRunning: boolean) => {
    // Read the live running map off the store rather than a render-scoped ref, so
    // a bridge that started since the last render is still protected.
    const running = bridgeActivity.snapshot().runningByBridge
    const dropped = new Set<string>()
    Object.entries(bridgesByKey)
      .filter(([key]) => match(key))
      .forEach(([, id]) => {
        const protectedByTurn = running[id] || startingBridgeIdsRef.current.has(id)
        if (protectedByTurn && !stopRunning) return
        bridge.stop(id)
        dropped.add(id)
      })
    if (dropped.size === 0) return
    setBridgesByKey(prev => {
      const n = { ...prev }
      for (const [key, id] of Object.entries(n)) if (dropped.has(id)) delete n[key]
      return n
    })
    setBridgeToTab(prev => {
      const n = { ...prev }
      for (const id of dropped) delete n[id]
      return n
    })
    setBridgeToCwd(prev => {
      const n = { ...prev }
      for (const id of dropped) delete n[id]
      return n
    })
    setBridgeToMode(prev => {
      const n = { ...prev }
      for (const id of dropped) delete n[id]
      return n
    })
    bridgeActivity.clearBridges(dropped)
    bridgeActivity.dropRequestsForBridges(dropped)
  }, [bridge, bridgesByKey])

  // Release every bridge under a tab, including all of its session scopes
  // (`tab`, `tab::s2`, …). In-flight bridges are preserved unless forced.
  const releaseTab = useCallback((tabId: string, opts?: { stopRunning?: boolean }) => {
    releaseBridgesWhere(key => key.startsWith(`${tabId}:`), opts?.stopRunning === true)
  }, [releaseBridgesWhere])

  // Release bridges for ONE exact session scope. Unlike releaseTab this must not
  // prefix-match, or deleting session `tab` would also kill sibling `tab::s2`
  // (whose bridge key `tab::s2:agent` starts with `tab:`) — freezing the chat the
  // user is actually in. agentId is colon-free, so the scope is everything before
  // the final ':'.
  const releaseScope = useCallback((scopeId: string, opts?: { stopRunning?: boolean }) => {
    releaseBridgesWhere(key => key.slice(0, key.lastIndexOf(':')) === scopeId, opts?.stopRunning === true)
  }, [releaseBridgesWhere])

  // Stop the live bridge for (tab, agent) and forget its persisted resume id.
  // The next ensureBridge call opens a brand-new upstream session — used by a
  // "New session" UI affordance to start a fresh chat without losing the tab.
  const resetSession = useCallback(async (tabId: string, agentId: string) => {
    const key = `${tabId}:${agentId}`
    const id  = bridgesByKey[key]
    if (id) {
      bridge.stop(id)
      setBridgesByKey(prev => { const n = { ...prev }; delete n[key]; return n })
      setBridgeToTab(prev => { const n = { ...prev }; delete n[id]; return n })
      setBridgeToCwd(prev => { const n = { ...prev }; delete n[id]; return n })
      setBridgeToMode(prev => { const n = { ...prev }; delete n[id]; return n })
      bridgeActivity.clearBridges([id])
    }
    bridgeActivity.clearTabRequests(tabId)
    await window.electronAPI?.bridgeResetSession(key, tabId)
  }, [bridge, bridgesByKey])

  const getBridgeId = useCallback((tabId: string, agentId: string) => {
    return bridgesByKey[`${tabId}:${agentId}`] ?? null
  }, [bridgesByKey])

  // Kept on the bundle because the workspaces drawer and Mission Control fan out
  // over every session. `runningByBridge` is a real dep, so this identity (and
  // therefore those memos) still updates when a turn starts or ends.
  // Status and queued follow-ups are read only by ChatPane, which subscribes to
  // bridge-activity-store directly — they intentionally have no accessor here.
  const isBridgeRunning = useCallback((tabId: string, agentId: string) => {
    if (runningByScope[tabId]) return true
    const bridgeId = bridgesByKeyRef.current[`${tabId}:${agentId}`] ?? bridgesByKey[`${tabId}:${agentId}`]
    return bridgeId ? !!runningByBridge[bridgeId] : false
  }, [bridgesByKey, runningByBridge, runningByScope])

  const removeQueuedFollowUp = useCallback(async (tabId: string, agentId: string, followUpId: string) => {
    const bridgeId = bridgesByKey[`${tabId}:${agentId}`]
    if (!bridgeId) return { ok: false, error: 'bridge not found' }
    const result = await bridge.removeFollowUp(bridgeId, followUpId)
    // The bridge's follow_up_removed event is the normal cleanup path; drop the
    // entry here too so the pill can't linger if that event is lost.
    if (result.ok) bridgeActivity.removeFollowUp(bridgeId, followUpId)
    return result
  }, [bridge, bridgesByKey])

  return {
    ensureBridge,
    prompt: bridge.prompt,
    compact: bridge.compact,
    handoff: bridge.handoff,
    abort:  bridge.abort,
    getBridgeId,
    isBridgeRunning,
    removeQueuedFollowUp,
    dropBridge,
    releaseTab,
    releaseScope,
    resetSession,
    respondUserRequest,
    subscribeTurnEnd,
    subscribeActivity,
  }
}
