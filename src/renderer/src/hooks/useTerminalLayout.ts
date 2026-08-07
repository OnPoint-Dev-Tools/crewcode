import { useCallback, useState } from 'react'

import type { useTweaks } from './useTweaks'
import type { TweakConfig } from '../types'

type SetTweak = ReturnType<typeof useTweaks<TweakConfig>>[1]

interface PtyLike {
  addShell: (wsId: string, tabId: string, cwd: string, shell?: string) => void
}

export interface UseTerminalLayoutOpts {
  activeWs: string
  activeTabId: string
  effectivePath: string
  paneCount: number
  pty: PtyLike
  setTweak: SetTweak
  shell?: string
}

export function useTerminalLayout(opts: UseTerminalLayoutOpts) {
  const { activeWs, activeTabId, effectivePath, paneCount, pty, setTweak, shell } = opts

  const [termSplit,  setTermSplit]  = useState<'right' | 'down'>('right')
  const [termWidth,  setTermWidth]  = useState(340)
  const [termHeight, setTermHeight] = useState(320)

  const openTerminalSplit = useCallback((dir: 'right' | 'down') => {
    setTermSplit(dir)
    setTweak('showTerminal', true)
    if (paneCount === 0) pty.addShell(activeWs, activeTabId, effectivePath, shell)
  }, [activeWs, activeTabId, effectivePath, paneCount, pty, setTweak, shell])

  return {
    termSplit, termWidth, termHeight,
    setTermWidth, setTermHeight,
    openTerminalSplit,
  }
}
