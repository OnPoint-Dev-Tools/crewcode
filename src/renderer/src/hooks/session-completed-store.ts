/**
 * Pure persistence logic for chat completion timestamps, split out from
 * useCompletedChats so it can be unit-tested without a DOM/localStorage. The
 * hook owns localStorage read/write; this module owns validation and bounding.
 */

export type CompletedMap = Record<string, number>

// Bound the persisted map so deleted/abandoned sessions can't grow it without
// limit (the same quota footgun that bit messagesByTab).
export const MAX_COMPLETED = 300

// Parse a persisted blob, keeping only finite-number timestamp entries. Any
// malformed shape or bad JSON degrades to an empty map rather than throwing.
export function parseCompletedMap(raw: string | null): CompletedMap {
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: CompletedMap = {}
    for (const [scope, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'number' && Number.isFinite(value)) out[scope] = value
    }
    return out
  } catch {
    return {}
  }
}

// Keep only the newest `max` entries by timestamp. Returns the input untouched
// when already within budget.
export function boundCompletedMap(map: CompletedMap, max: number = MAX_COMPLETED): CompletedMap {
  const entries = Object.entries(map)
  if (entries.length <= max) return map
  const kept = entries.sort((a, b) => b[1] - a[1]).slice(0, max)
  return Object.fromEntries(kept)
}

// Remove the given scopes; returns the original reference when nothing changed
// so callers can skip redundant state updates.
export function forgetScopes(map: CompletedMap, scopes: string[]): CompletedMap {
  let changed = false
  const next = { ...map }
  for (const scope of scopes) {
    if (scope in next) { delete next[scope]; changed = true }
  }
  return changed ? next : map
}
