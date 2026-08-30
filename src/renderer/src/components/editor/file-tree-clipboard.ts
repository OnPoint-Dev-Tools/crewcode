export type TreeClipboardMode = 'copy' | 'cut'

export interface TreeClipboard {
  rel: string
  kind: 'dir' | 'file'
  mode: TreeClipboardMode
}

export function parentRel(rel: string): string {
  return rel.includes('/') ? rel.substring(0, rel.lastIndexOf('/')) : ''
}

/** Folder that should receive a paste for the current context-menu target. */
export function pasteTargetDirRel(node: { rel: string; kind: 'dir' | 'file' } | null, isDir: boolean): string {
  if (!node) return ''
  if (isDir || node.kind === 'dir') return node.rel
  return parentRel(node.rel)
}

/** Folders cannot be pasted into themselves or a descendant. Cut also refuses the current parent. */
export function canPasteInto(clip: Pick<TreeClipboard, 'rel' | 'kind' | 'mode'>, destDirRel: string): boolean {
  if (!clip.rel) return false
  if (clip.kind === 'dir' && (destDirRel === clip.rel || destDirRel.startsWith(`${clip.rel}/`))) return false
  if (clip.mode === 'cut' && parentRel(clip.rel) === destDirRel) return false
  return true
}
