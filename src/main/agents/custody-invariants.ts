// Authority-drift detection and mutation policy for live agent bridges.
//
// The invariant vocabulary itself lives in shared/custody-types.ts so the
// renderer's halt banner and main's tripwire cannot drift apart. This module
// adds the parts only main needs: what "the authority a turn is executing
// under" actually consists of, how to tell when it changed, and which
// mutations are allowed to land while a turn is in flight.
//
// Pure and Electron-free so it can be unit-tested and reused by any transport.

import type { ModeLevel } from '../../shared/mode-types'
import {
  CUSTODY_INVARIANTS,
  custodyViolation,
  type CustodyInvariantId,
  type CustodyScope,
  type CustodyViolation,
} from '../../shared/custody-types'

export {
  CUSTODY_INVARIANTS,
  custodyViolation as violation,
  type CustodyInvariantId,
  type CustodyScope,
  type CustodyViolation,
}

/**
 * The exact tuple a grant is scoped to. Anything in here changing while a turn
 * is in flight means the turn is executing under authority that was never
 * approved for it.
 */
export interface CustodyAuthority {
  provider: string
  cwd: string
  mode: ModeLevel
  crewcoderMode: string
  crewcoderApprovalMode: string
  toolPolicy: string
  externalDirectories: string[]
  mcpServers: string[]
}

export interface CustodyAuthorityInput {
  provider: string
  cwd: string
  mode?: ModeLevel
  crewcoderMode?: string
  crewcoderApprovalMode?: string
  toolPolicy?: string
  externalDirectories?: string[]
  mcpServers?: Array<{ name?: string } | string>
}

/** Stable, order-independent authority snapshot. Sorting keeps config reordering from reading as drift. */
export function normalizeAuthority(input: CustodyAuthorityInput): CustodyAuthority {
  return {
    provider: input.provider,
    cwd: input.cwd,
    mode: input.mode ?? 'build',
    crewcoderMode: input.crewcoderMode ?? 'configured',
    crewcoderApprovalMode: input.crewcoderApprovalMode ?? 'review',
    toolPolicy: input.toolPolicy ?? 'default',
    externalDirectories: [...(input.externalDirectories ?? [])].sort(),
    mcpServers: (input.mcpServers ?? [])
      .map(server => (typeof server === 'string' ? server : server?.name ?? ''))
      .filter(name => name.length > 0)
      .sort(),
  }
}

export interface AuthorityDrift {
  field: keyof CustodyAuthority
  recorded: string
  observed: string
}

function render(value: string | string[]): string {
  return Array.isArray(value) ? (value.length ? value.join(', ') : '(none)') : value
}

/** Field-by-field comparison. Empty result means the live authority still matches the record. */
export function diffAuthority(recorded: CustodyAuthority, observed: CustodyAuthority): AuthorityDrift[] {
  const fields: Array<keyof CustodyAuthority> = ['provider', 'cwd', 'mode', 'crewcoderMode', 'crewcoderApprovalMode', 'toolPolicy', 'externalDirectories', 'mcpServers']
  const drift: AuthorityDrift[] = []
  for (const field of fields) {
    const before = render(recorded[field])
    const after = render(observed[field])
    if (before !== after) drift.push({ field, recorded: before, observed: after })
  }
  return drift
}

/** One-line, human-readable statement of the exact failed invariant. */
export function describeDrift(drift: AuthorityDrift[]): string {
  return drift.map(item => `${item.field}: recorded "${item.recorded}", now "${item.observed}"`).join('; ')
}

/**
 * Authority mutation policy for a live bridge.
 *
 * A mode change requested while a turn is in flight is neither applied nor
 * treated as a violation — it is refused and deferred to the next turn. The
 * turn keeps executing under exactly the authority it started with, and the
 * user's choice still takes effect without killing in-progress work. Escalating
 * authority underneath a running turn is the case this exists to forbid.
 */
export type ModeChangeDecision =
  | { apply: true; deferred?: undefined; reason?: undefined }
  | { apply: false; deferred: true; reason: string }

export function decideModeChange(current: ModeLevel | undefined, next: ModeLevel, running: boolean): ModeChangeDecision {
  if ((current ?? 'build') === next) return { apply: true }
  if (!running) return { apply: true }
  return {
    apply: false,
    deferred: true,
    reason: `Mode stays ${current ?? 'build'} until this turn ends; ${next} applies to the next turn.`,
  }
}

/**
 * Privileged actions that must be refused while a bridge is halted. Read-only
 * inspection (status, journal reads) is deliberately not in this set — a halt
 * must never hide the evidence it was raised to preserve.
 */
export type PrivilegedAction = 'prompt' | 'authorize' | 'respond' | 'compact' | 'handoff' | 'setMode' | 'removeFollowUp'

export function refusalMessage(action: PrivilegedAction, halt: CustodyViolation): string {
  return `${action} refused: ${CUSTODY_INVARIANTS[halt.invariant].title.toLowerCase()} — ${halt.detail}. Reauthorize this thread to continue.`
}

/**
 * Build the drift violation for a bridge whose live authority no longer matches
 * its custody record. Returns null when nothing drifted.
 */
export function authorityDriftViolation(
  recorded: CustodyAuthority,
  observed: CustodyAuthority,
  scope: CustodyScope,
  at: number = Date.now(),
): CustodyViolation | null {
  const drift = diffAuthority(recorded, observed)
  if (!drift.length) return null
  return custodyViolation(
    'authority-drift',
    `authority changed underneath a live grant — ${describeDrift(drift)}`,
    scope,
    at,
  )
}
