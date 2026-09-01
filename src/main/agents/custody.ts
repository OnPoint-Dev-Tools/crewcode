// Electron-facing custody service: one journal instance, and the small helpers
// the bridge coordinator needs to open, verify, and halt an execution record.
//
// The policy itself is in custody-invariants.ts (pure) and the persistence is in
// custody-journal.ts (pure). This file only supplies the app-specific bits:
// where the journal lives, and how to snapshot a BridgeStartOpts as authority.

import electron from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import { isRemoteRoot } from '../remote/ssh-target'
import { CustodyJournal, custodyScopeKey } from './custody-journal'
import { normalizeAuthority, violation, type CustodyAuthority, type CustodyViolation } from './custody-invariants'
import type { BridgeStartOpts } from './bridge-types'
import { crewCoderApprovalForProfile } from '../../shared/crewcoder-types'

const { app } = electron

let journal: CustodyJournal | null = null

/**
 * Lazily opened so the restart-recovery pass (running -> halted) runs once, on
 * first use, after Electron knows its userData path.
 */
export function custodyJournal(): CustodyJournal {
  if (!journal) {
    const dir = process.env.CREWCODE_DATA_DIR || app.getPath('userData')
    journal = new CustodyJournal(join(dir, 'agent-custody-journal.json'))
  }
  return journal
}

export function scopeKeyFor(sessionKey: string | null, bridgeId: string): string {
  return custodyScopeKey({ sessionKey, bridgeId })
}

export function authorityOf(opts: BridgeStartOpts): CustodyAuthority {
  return normalizeAuthority({
    provider: opts.provider,
    cwd: opts.cwd,
    mode: opts.mode,
    crewcoderMode: opts.crewcoderMode,
    crewcoderApprovalMode: crewCoderApprovalForProfile(opts.crewcoderMode, opts.crewcoderApprovalMode),
    toolPolicy: opts.toolPolicy,
    externalDirectories: opts.externalDirectories,
    mcpServers: opts.mcpServers,
  })
}

/**
 * The workspace root a grant was scoped to must still be there. Remote (ssh://)
 * roots are not asserted here: a stat would be a network round trip on every
 * privileged action, and their real boundary is the pinned host key at connect
 * time. Returns the violation, or null when the scope is intact.
 */
export function scopeViolation(
  opts: Pick<BridgeStartOpts, 'cwd' | 'provider' | 'bridgeId'>,
  sessionKey: string | null,
  turnId?: string,
  at: number = Date.now(),
): CustodyViolation | null {
  if (isRemoteRoot(opts.cwd)) return null
  if (existsSync(opts.cwd)) return null
  return violation(
    'scope-unknown',
    `the workspace root this session was granted (${opts.cwd}) no longer exists`,
    { bridgeId: opts.bridgeId, provider: opts.provider, cwd: opts.cwd, turnId, sessionKey },
    at,
  )
}
