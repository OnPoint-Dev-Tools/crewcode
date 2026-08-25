import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'fs'
import { dirname, join, sep } from 'path'
import type { BrainAccessScope } from '../shared/hub-relay-types'

const VALID_SCOPES = new Set<BrainAccessScope>(['workspace:read', 'workspace:write', 'terminal', 'agent'])
const MAX_ROOTS = 100
const MAX_AUDIT_EVENTS = 200
export interface BrainAuthorizationAuditEvent { at: number; userId: string; previousScopes: BrainAccessScope[]; scopes: BrainAccessScope[]; previousRoots: string[]; roots: string[] }
export interface BrainAuthorizationSnapshot { version: 1; scopes: BrainAccessScope[]; roots: string[]; updatedAt: number; audit: BrainAuthorizationAuditEvent[] }

function normalizeRoots(values: unknown[]): string[] {
  if (values.length > MAX_ROOTS) throw new Error(`Brain authorization supports at most ${MAX_ROOTS} workspace roots`)
  const roots: string[] = []
  for (const value of values) {
    if (typeof value !== 'string' || !value.trim() || value.length > 4096) throw new Error('workspace roots must be non-empty paths')
    if (!existsSync(value) || !statSync(value).isDirectory()) throw new Error(`workspace root does not exist or is not a directory: ${value}`)
    const root = realpathSync(value)
    if (!roots.includes(root)) roots.push(root)
  }
  return roots.sort()
}
function normalizeScopes(values: unknown[]): BrainAccessScope[] {
  if (values.length > VALID_SCOPES.size) throw new Error('Brain scopes must be a bounded array')
  const scopes = values.map(String) as BrainAccessScope[]
  if (scopes.some(scope => !VALID_SCOPES.has(scope)) || new Set(scopes).size !== scopes.length) throw new Error('Brain scopes contain an invalid or duplicate value')
  return scopes.sort()
}
export function pathWithinRoots(candidate: string, roots: string[]): boolean {
  let resolved: string
  try { resolved = realpathSync(candidate) } catch { return false }
  return roots.some(root => resolved === root || resolved.startsWith(root + sep))
}
export class BrainAuthorizationPolicy {
  private snapshot: BrainAuthorizationSnapshot
  constructor(readonly path: string, initialRoots: string[], initialScopes: BrainAccessScope[], private readonly now: () => number = Date.now) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    try { chmodSync(dirname(path), 0o700) } catch { /* Windows */ }
    this.snapshot = this.load() ?? { version: 1, roots: normalizeRoots(initialRoots), scopes: normalizeScopes(initialScopes), updatedAt: this.now(), audit: [] }
    this.persist()
  }
  current(): BrainAuthorizationSnapshot { return JSON.parse(JSON.stringify(this.snapshot)) as BrainAuthorizationSnapshot }
  allowsScope(scope: BrainAccessScope): boolean { return this.snapshot.scopes.includes(scope) }
  update(input: { roots: unknown; scopes: unknown; userId: string }): BrainAuthorizationSnapshot {
    if (!Array.isArray(input.roots) || !Array.isArray(input.scopes)) throw new Error('roots and scopes must be arrays')
    const roots = normalizeRoots(input.roots); const scopes = normalizeScopes(input.scopes)
    if (scopes.length > 0 && roots.length === 0) throw new Error('remote scopes require at least one workspace root')
    const previous = this.snapshot
    const event: BrainAuthorizationAuditEvent = { at: this.now(), userId: input.userId, previousScopes: previous.scopes, scopes, previousRoots: previous.roots, roots }
    this.snapshot = { version: 1, roots, scopes, updatedAt: event.at, audit: [...previous.audit, event].slice(-MAX_AUDIT_EVENTS) }
    this.persist(); return this.current()
  }
  private load(): BrainAuthorizationSnapshot | null {
    if (!existsSync(this.path)) return null
    try {
      const value = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<BrainAuthorizationSnapshot>
      if (value.version !== 1 || !Array.isArray(value.roots) || !Array.isArray(value.scopes)) throw new Error('invalid authorization policy')
      return { version: 1, roots: normalizeRoots(value.roots), scopes: normalizeScopes(value.scopes), updatedAt: Number.isFinite(value.updatedAt) ? Number(value.updatedAt) : this.now(), audit: Array.isArray(value.audit) ? value.audit.slice(-MAX_AUDIT_EVENTS) as BrainAuthorizationAuditEvent[] : [] }
    } catch (error) { throw new Error(`could not load Brain authorization policy ${this.path}: ${(error as Error).message}`) }
  }
  private persist(): void {
    const temporary = `${this.path}.${process.pid}.tmp`
    writeFileSync(temporary, `${JSON.stringify(this.snapshot, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    try { chmodSync(temporary, 0o600) } catch { /* Windows */ }
    renameSync(temporary, this.path)
    try { chmodSync(this.path, 0o600) } catch { /* Windows */ }
  }
}
export function brainAuthorizationPolicyPath(dataDir: string): string { return join(dataDir, 'brain-authorization.json') }
