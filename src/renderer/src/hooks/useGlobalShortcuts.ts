import { useEffect, useRef } from 'react'

import { effectiveChord, LOCAL_SHORTCUTS, matchesChord, SHORTCUTS, type ActionId } from '../shortcuts'

type ShortcutOverrides = Record<string, Record<string, string[]>> | undefined

export interface UseGlobalShortcutsOpts {
  overrides: ShortcutOverrides
  /** Single dispatch callback for any matched shortcut id. The host owns all
      action-specific state (palette open, drawer open, workspace list, etc.). */
  handleAction: (id: ActionId) => void
}

export function useGlobalShortcuts({ overrides, handleAction }: UseGlobalShortcutsOpts) {
  const ref = useRef({ overrides, handleAction })
  ref.current = { overrides, handleAction }

  useEffect(() => {
    const fn = (e: KeyboardEvent): void => {
      const { overrides: ov, handleAction: dispatch } = ref.current
      for (const s of SHORTCUTS) {
        // Skip component-local actions — those are dispatched by App.tsx via
        // a synthetic keydown (so the local listener fires from anywhere)
        // and we don't want to double-handle them on real keypresses.
        if (LOCAL_SHORTCUTS.has(s.id)) continue
        const chord = effectiveChord(s.id, ov as any)
        if (chord.length === 0) continue
        if (!matchesChord(e, chord)) continue
        e.preventDefault()
        dispatch(s.id)
        return
      }
    }
    window.addEventListener('keydown', fn)
    return () => window.removeEventListener('keydown', fn)
  }, [])
}
