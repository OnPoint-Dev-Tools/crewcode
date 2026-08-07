export interface MarkdownDraftSnapshot {
  root: string
  rel: string | null
  text: string
  savedText?: string
  dirty: boolean
  unsaved: boolean
  sourceOnly: boolean
  parseError?: string | null
}

const STORAGE_PREFIX = 'crewcode:markdownDraft:'

function storageKey(scope: string): string {
  return `${STORAGE_PREFIX}${scope}`
}

export function loadMarkdownDraft(scope: string, root: string): MarkdownDraftSnapshot | null {
  try {
    const raw = localStorage.getItem(storageKey(scope))
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<MarkdownDraftSnapshot>
    if (parsed.root !== root) return null
    if (typeof parsed.text !== 'string') return null
    return {
      root,
      rel: typeof parsed.rel === 'string' ? parsed.rel : null,
      text: parsed.text,
      savedText: typeof parsed.savedText === 'string' ? parsed.savedText : undefined,
      dirty: Boolean(parsed.dirty),
      unsaved: Boolean(parsed.unsaved),
      sourceOnly: Boolean(parsed.sourceOnly),
      parseError: typeof parsed.parseError === 'string' ? parsed.parseError : null,
    }
  } catch {
    return null
  }
}

export function saveMarkdownDraft(scope: string, snapshot: MarkdownDraftSnapshot): void {
  try {
    localStorage.setItem(storageKey(scope), JSON.stringify(snapshot))
  } catch {
    // Quota failures should not interrupt editing; the in-memory draft still exists.
  }
}

export function clearMarkdownDraft(scope: string): void {
  try {
    localStorage.removeItem(storageKey(scope))
  } catch {
    // Non-fatal.
  }
}
