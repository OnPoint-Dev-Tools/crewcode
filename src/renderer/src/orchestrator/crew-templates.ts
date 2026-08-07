/**
 * crew-templates — persisted presets for one-click crew launches.
 *
 * A template captures the *configuration* of a crew (mode + lanes), not its
 * runtime — no worktree ids, no bridges, no chat threads. Storage is plain
 * localStorage; templates are global to the install rather than per-workspace,
 * since the value is reusing a pairing like "claude + codex side-by-side" across
 * many repos.
 */

import { NO_ROLE, type CrewMode, type CrewRoleAssignment, type CrewLaneEffort } from './crew-session'

const STORAGE_KEY = 'crewcode:crew-templates:v1'

export interface CrewTemplateLane {
  agentId: string
  role:    CrewRoleAssignment
  model:   string
  effort:  CrewLaneEffort
}

export interface CrewTemplate {
  id:        string
  name:      string
  mode:      CrewMode
  lanes:     CrewTemplateLane[]
  createdAt: number
}

function isLane(x: unknown): x is CrewTemplateLane {
  if (!x || typeof x !== 'object') return false
  const o = x as Record<string, unknown>
  // `role` may be a string (legacy v1 templates) or an assignment object — both
  // accepted here; normalizeLane coerces the legacy form on load.
  const roleOk = typeof o.role === 'string' || (!!o.role && typeof o.role === 'object')
  return typeof o.agentId === 'string'
    && roleOk
    && typeof o.model   === 'string'
    && (o.effort === null || typeof o.effort === 'string')
}

/** Coerce a legacy string `role` into a full assignment so old templates still load. */
function normalizeLane(lane: CrewTemplateLane): CrewTemplateLane {
  if (typeof lane.role === 'string') {
    const name = lane.role as string
    return { ...lane, role: { ...NO_ROLE, roleName: name } }
  }
  return lane
}

function isTemplate(x: unknown): x is CrewTemplate {
  if (!x || typeof x !== 'object') return false
  const o = x as Record<string, unknown>
  return typeof o.id        === 'string'
    && typeof o.name      === 'string'
    && (o.mode === 'isolated' || o.mode === 'shared')
    && Array.isArray(o.lanes) && o.lanes.every(isLane)
    && typeof o.createdAt === 'number'
}

export function loadCrewTemplates(): CrewTemplate[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter(isTemplate)
      .map(t => ({ ...t, lanes: t.lanes.map(normalizeLane) }))
  } catch {
    return []
  }
}

function saveAll(templates: CrewTemplate[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(templates))
  } catch {
    // localStorage may be unavailable or quota exceeded — non-fatal.
  }
}

let seq = 0
function newId(): string {
  seq += 1
  return `tpl-${Date.now().toString(36)}-${seq.toString(36)}`
}

export function saveCrewTemplate(
  name: string,
  mode: CrewMode,
  lanes: CrewTemplateLane[],
): CrewTemplate {
  const all = loadCrewTemplates()
  const tpl: CrewTemplate = {
    id:        newId(),
    name:      name.trim() || `crew · ${all.length + 1}`,
    mode,
    lanes,
    createdAt: Date.now(),
  }
  saveAll([tpl, ...all])
  return tpl
}

export function deleteCrewTemplate(id: string): void {
  saveAll(loadCrewTemplates().filter(t => t.id !== id))
}

export function renameCrewTemplate(id: string, name: string): void {
  saveAll(loadCrewTemplates().map(t => t.id === id ? { ...t, name: name.trim() || t.name } : t))
}
