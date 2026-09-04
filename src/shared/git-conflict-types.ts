export interface GitConflictDiffResult {
  ok: boolean
  patch: string
  oursAvailable: boolean
  theirsAvailable: boolean
  error?: string
}
