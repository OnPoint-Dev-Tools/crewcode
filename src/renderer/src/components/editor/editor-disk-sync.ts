export interface DiskSyncBuffer {
  text: string
  originalText: string
}

export type DiskSyncDecision = 'in-sync' | 'reload' | 'conflict'

/** Decide without ever treating an unsaved editor buffer as disposable. */
export function diskSyncDecision(buffer: DiskSyncBuffer, diskText: string): DiskSyncDecision {
  if (diskText === buffer.text) return 'in-sync'
  if (buffer.text === buffer.originalText) return 'reload'
  return diskText === buffer.originalText ? 'in-sync' : 'conflict'
}
