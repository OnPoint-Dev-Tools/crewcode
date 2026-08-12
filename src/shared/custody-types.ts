// Canonical execution-custody vocabulary shared by main and the renderer.
//
// The security model's gates decide whether authority MAY cross the next
// boundary. Custody covers the other half of the lifecycle: what happens when
// authority that was already granted stops being knowable while execution is
// still in flight.
//
// Doctrine (see docs/execution-custody.md):
//   silence != success, timeout != success, lost telemetry != success,
//   missing process state != success, clean Git state != behavioral correctness.
//
// No Electron imports.

export type CustodyInvariantId =
  /** Live authority no longer matches what was recorded when execution began. */
  | 'authority-drift'
  /** The owned provider process ended while a turn was still in flight. */
  | 'execution-custody-lost'
  /** The workspace root the grant was scoped to is gone or no longer the same root. */
  | 'scope-unknown'
  /** CrewCode restarted while a turn was in flight; that turn's effects are unknown. */
  | 'restart-recovery'
  /** A permission request outlived the bridge that asked for it. */
  | 'orphaned-authorization'

export interface CustodyInvariant {
  id: CustodyInvariantId
  /** Short label shown on the halt banner. */
  title: string
  /**
   * True when tripping this invariant must refuse further privileged actions
   * until a human reauthorizes. False means "record and report" only — the
   * state is known-bad, not unknown, so it needs no human gate to proceed.
   */
  halts: boolean
}

export const CUSTODY_INVARIANTS: Record<CustodyInvariantId, CustodyInvariant> = {
  'authority-drift':        { id: 'authority-drift',        title: 'Authority changed mid-execution', halts: true },
  'execution-custody-lost': { id: 'execution-custody-lost', title: 'Lost custody of a running turn',  halts: true },
  'scope-unknown':          { id: 'scope-unknown',          title: 'Workspace scope is unknown',      halts: true },
  'restart-recovery':       { id: 'restart-recovery',       title: 'Turn interrupted by restart',     halts: true },
  'orphaned-authorization': { id: 'orphaned-authorization', title: 'Permission request orphaned',     halts: false },
}

/** Exactly what a tripped invariant affected. Reported verbatim, never generalized. */
export interface CustodyScope {
  bridgeId: string
  provider: string
  cwd: string
  turnId?: string
  sessionKey?: string | null
}

export interface CustodyViolation {
  invariant: CustodyInvariantId
  /** The exact failed invariant, stated plainly. Shown to the user verbatim. */
  detail: string
  scope: CustodyScope
  at: number
  /** True when this violation must refuse privileged actions until reauthorized. */
  halts: boolean
}

/** Halt notification delivered to the renderer, carrying the preserved evidence. */
export interface CustodyHaltPayload {
  /** Stable thread key the halt is in force for ("tabId:agentId", or "bridge:<id>"). */
  scopeKey: string
  violation: CustodyViolation
  /** What the interrupted turn was asked to do, preserved before teardown. */
  interruptedPrompt?: string
  /** Whatever the agent had produced before custody was lost. */
  interruptedPartial?: string
}

/**
 * Execution-custody halts are a crew-lane safety feature. Crew lane thread keys
 * are `crew/<laneId>:<agentId>`; supervisor keys contain another `/` and are not
 * lane execution. Ordinary chat tab IDs must never inherit this gating policy.
 */
export function isCrewLaneSessionKey(sessionKey: string | null | undefined): boolean {
  if (!sessionKey) return false
  const separator = sessionKey.indexOf(':')
  const tabId = separator >= 0 ? sessionKey.slice(0, separator) : sessionKey
  return /^crew\/[^/]+$/.test(tabId)
}

export function custodyViolation(
  invariant: CustodyInvariantId,
  detail: string,
  scope: CustodyScope,
  at: number = Date.now(),
): CustodyViolation {
  return { invariant, detail, scope, at, halts: CUSTODY_INVARIANTS[invariant].halts }
}
