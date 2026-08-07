/**
 * crew-roles — user-defined agent roles, persisted globally for reuse.
 *
 * A role is a reusable definition the user authors in a modal: a `name`, a
 * `role` descriptor, and standing `instructions`. When a lane adopts a role,
 * all three are denormalized onto the lane and injected verbatim into the
 * worker's priming preamble on spawn (see buildWorkerPreamble). Storage mirrors
 * crew-templates: plain localStorage, global to the install rather than
 * per-workspace, since the value is reusing a definition like "Security Auditor"
 * across every repo.
 */

const STORAGE_KEY = 'crewcode:crew-roles:v1'

export interface CrewRole {
  id:           string
  name:         string   // label shown in the lane picker + supervisor targeting token
  role:         string   // short descriptor of what the agent does
  instructions: string   // detailed standing instructions
  createdAt:    number
}

function isRole(x: unknown): x is CrewRole {
  if (!x || typeof x !== 'object') return false
  const o = x as Record<string, unknown>
  return typeof o.id           === 'string'
    && typeof o.name         === 'string'
    && typeof o.role         === 'string'
    && typeof o.instructions === 'string'
    && typeof o.createdAt    === 'number'
}

export function loadCrewRoles(): CrewRole[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isRole)
  } catch {
    return []
  }
}

function saveAll(roles: CrewRole[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(roles))
  } catch {
    // localStorage may be unavailable or quota exceeded — non-fatal.
  }
}

let seq = 0
function newId(): string {
  seq += 1
  return `role-${Date.now().toString(36)}-${seq.toString(36)}`
}

export interface CrewRoleInput {
  name:         string
  role:         string
  instructions: string
}

export function saveCrewRole(input: CrewRoleInput): CrewRole {
  const all = loadCrewRoles()
  const role: CrewRole = {
    id:           newId(),
    name:         input.name.trim() || `role · ${all.length + 1}`,
    role:         input.role.trim(),
    instructions: input.instructions.trim(),
    createdAt:    Date.now(),
  }
  saveAll([role, ...all])
  return role
}

export function updateCrewRole(id: string, input: CrewRoleInput): CrewRole | null {
  const all = loadCrewRoles()
  let updated: CrewRole | null = null
  const next = all.map(r => {
    if (r.id !== id) return r
    updated = {
      ...r,
      name:         input.name.trim() || r.name,
      role:         input.role.trim(),
      instructions: input.instructions.trim(),
    }
    return updated
  })
  if (updated) saveAll(next)
  return updated
}

export function deleteCrewRole(id: string): void {
  saveAll(loadCrewRoles().filter(r => r.id !== id))
}
