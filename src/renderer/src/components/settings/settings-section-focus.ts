export const SETTINGS_SECTION_EVENT = 'crewcode:settings-section'

let pendingSection: string | null = null

/** Remember a Settings section to scroll into view. Safe to call before the
 *  Settings tab is mounted: the screen consumes the pending id on mount, and
 *  an already-open screen also hears the window event. */
export function requestSettingsSection(id: string): void {
  const section = id.trim()
  if (!section) return
  pendingSection = section
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(SETTINGS_SECTION_EVENT, { detail: section }))
}

export function takePendingSettingsSection(): string | null {
  const id = pendingSection
  pendingSection = null
  return id
}
