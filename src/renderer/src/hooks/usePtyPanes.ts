import { useState, useCallback } from 'react'
import type { PtyPane } from '../types'

let counter = 0
function nextPaneId(prefix: string): string {
  counter += 1
  return `${prefix}-${Date.now().toString(36)}-${counter}`
}

export function usePtyPanes() {
  const [panes, setPanes] = useState<PtyPane[]>([])

  // `shell` is forwarded to pty:create. The main process accepts the aliases
  // "auto"/"bash"/"zsh"/"fish" plus literal paths; "auto"/undefined falls back
  // to $SHELL.
  const addShell = useCallback((wsId: string, tabId: string, cwd: string, shell?: string) => {
    const pane: PtyPane = {
      paneId:  nextPaneId(`${wsId}-sh`),
      wsId,
      tabId,
      agentId: null,
      title:   shell && shell !== 'auto' ? shell : 'shell',
      sub:     cwd,
      cwd,
      live:    true,
      shell,
    }
    setPanes(p => [...p, pane])
    return pane
  }, [])

  const addSsh = useCallback((wsId: string, tabId: string, target: string, cwd: string) => {
    // target is "user@host[:port]" or a config alias. Port is split out so we
    // can pass it as `-p` instead of letting ssh choke on "host:port".
    const portMatch = target.match(/^(.+):(\d+)$/)
    const host = portMatch ? portMatch[1] : target
    const argv = portMatch ? ['-p', portMatch[2], host] : [host]
    const pane: PtyPane = {
      paneId:  nextPaneId(`${wsId}-ssh`),
      wsId,
      tabId,
      agentId: null,
      title:   `ssh · ${target}`,
      sub:     target,
      cwd,
      live:    true,
      shell:   'ssh',
      argv,
    }
    setPanes(p => [...p, pane])
    return pane
  }, [])

  const addAgent = useCallback((wsId: string, tabId: string, agentId: string, agentName: string, cwd: string) => {
    const pane: PtyPane = {
      paneId:  nextPaneId(`${wsId}-${agentId}`),
      wsId,
      tabId,
      agentId,
      title:   agentName,
      sub:     `${agentId} · ${cwd}`,
      cwd,
      live:    true,
    }
    setPanes(p => [...p, pane])
    return pane
  }, [])

  const close = useCallback((paneId: string) => {
    setPanes(p => p.filter(x => x.paneId !== paneId))
  }, [])

  const write = useCallback((paneId: string, data: string) => {
    window.electronAPI?.ptyWrite(paneId, data)
  }, [])

  return { panes, addShell, addSsh, addAgent, close, write }
}
