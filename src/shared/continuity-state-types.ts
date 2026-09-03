export interface ContinuityStateSnapshot {
  version: 1
  revision: number
  updatedAt: number
  values: Record<string, string>
}

/** Bounded metadata used to reconstruct a missing renderer chat catalogue.
 * Transcript bodies remain in their per-scope Brain shards. */
export const DESKTOP_CATALOGUE_AUTHORITY_KEY = 'crewcode:desktopCatalogueAuthority:v1' as const
export const DESKTOP_CATALOGUE_AUTHORITY_VALUE = JSON.stringify({ version: 1, source: 'desktop' })

export interface ContinuityTranscriptEntry {
  scopeId: string
  updatedAt: number
  agentId?: string
  model?: string
  /** Desktop-matching four-word title from the first user prompt, never the body. */
  titleHint?: string
}
