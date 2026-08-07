import { useCallback, useEffect, useState } from 'react'
import type { McpFileSnapshot } from '../../../shared/mcp-types'

const EMPTY: McpFileSnapshot = { path: '', exists: false, servers: [], errors: [] }

// Loads the user-editable ~/.crewcode/mcp.json registry and stays live: the main
// process watches the file and pushes `mcp:changed` whenever it's edited, so the
// composer and Settings reflect manual edits without a reload.
export function useMcpFileServers(): McpFileSnapshot & { refresh: () => void; openFile: () => void } {
  const [snapshot, setSnapshot] = useState<McpFileSnapshot>(EMPTY)

  const refresh = useCallback(() => {
    void window.electronAPI?.mcpList?.().then(next => { if (next) setSnapshot(next) })
  }, [])

  useEffect(() => { refresh() }, [refresh])

  useEffect(() => {
    const off = window.electronAPI?.onMcpChanged?.(event => setSnapshot(event))
    return () => off?.()
  }, [])

  const openFile = useCallback(() => { void window.electronAPI?.mcpOpenFile?.() }, [])

  return { ...snapshot, refresh, openFile }
}
