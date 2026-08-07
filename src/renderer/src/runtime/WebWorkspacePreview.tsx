import { useEffect, useRef, useState } from 'react'
import type { FsNode, StoredWorkspace } from '../types'
import { getCrewCodeClient } from './crewcode-client'
import { WebAgentChat } from './WebAgentChat'

export function WebWorkspacePreview({ onDisconnect }: { onDisconnect: () => void }) {
  const [workspaces, setWorkspaces] = useState<StoredWorkspace[]>([])
  const [selected, setSelected] = useState<StoredWorkspace | null>(null)
  const [nodes, setNodes] = useState<FsNode[]>([])
  const [activeFile, setActiveFile] = useState<{ rel: string; text: string; savedText: string } | null>(null)
  const [status, setStatus] = useState('Loading workspaces…')
  const [saving, setSaving] = useState(false)
  const [terminalOutput, setTerminalOutput] = useState('')
  const [terminalOpen, setTerminalOpen] = useState(false)
  const [chatOpen, setChatOpen] = useState(false)
  const terminalPaneId = useRef(`web-terminal-${Date.now().toString(36)}`)

  useEffect(() => {
    void getCrewCodeClient().workspacesList()
      .then(next => { setWorkspaces(next); setStatus(next.length ? 'Select a workspace' : 'No workspaces configured on this server') })
      .catch(error => setStatus((error as Error).message))
  }, [])

  useEffect(() => {
    const api = getCrewCodeClient()
    const offData = api.onPtyDataForPane(terminalPaneId.current, data => setTerminalOutput(current => (current + data).slice(-500_000)))
    const offExit = api.onPtyExit(event => {
      if (event.paneId === terminalPaneId.current) setTerminalOutput(current => `${current}\r\n[process exited ${event.exitCode}]\r\n`)
    })
    return () => { offData(); offExit(); api.ptyKill(terminalPaneId.current) }
  }, [])

  const openWorkspace = async (workspace: StoredWorkspace) => {
    if (selected && selected.id !== workspace.id) getCrewCodeClient().ptyKill(terminalPaneId.current)
    setSelected(workspace)
    setTerminalOpen(false)
    setChatOpen(false)
    setActiveFile(null)
    setStatus(`Loading ${workspace.name}…`)
    try {
      const result = await getCrewCodeClient().fsReadDir(workspace.path, '')
      if (result.error) throw new Error(result.error)
      setNodes(result.nodes ?? [])
      setStatus(workspace.path)
    } catch (error) { setStatus((error as Error).message) }
  }

  const openFile = async (node: FsNode) => {
    if (!selected || node.kind !== 'file') return
    setTerminalOpen(false)
    setChatOpen(false)
    setStatus(`Loading ${node.rel}…`)
    try {
      const result = await getCrewCodeClient().fsReadFile(selected.path, node.rel)
      if (!result.ok || typeof result.text !== 'string') throw new Error(result.error ?? 'could not read file')
      setActiveFile({ rel: node.rel, text: result.text, savedText: result.text })
      setStatus(node.rel)
    } catch (error) { setStatus((error as Error).message) }
  }

  const openTerminal = async () => {
    if (!selected) return
    setChatOpen(false)
    setTerminalOpen(true)
    setTerminalOutput('Connecting terminal…\r\n')
    const result = await getCrewCodeClient().ptyCreate({ paneId: terminalPaneId.current, cwd: selected.path, cols: 100, rows: 30 })
    if (result.error) setTerminalOutput(`Terminal failed: ${result.error}\r\n`)
    else setTerminalOutput(result.buffer ?? '')
  }

  const saveFile = async () => {
    if (!selected || !activeFile || activeFile.text === activeFile.savedText) return
    setSaving(true)
    setStatus(`Saving ${activeFile.rel}…`)
    try {
      const result = await getCrewCodeClient().fsWriteFile(selected.path, activeFile.rel, activeFile.text)
      if (!result.ok) throw new Error(result.error ?? 'could not save file')
      setActiveFile(current => current ? { ...current, savedText: current.text } : current)
      setStatus(`Saved ${activeFile.rel}`)
    } catch (error) { setStatus((error as Error).message) }
    finally { setSaving(false) }
  }

  return (
    <main style={{ minHeight: '100vh', background: '#0f120f', color: '#d7e0dc', fontFamily: 'Inter, sans-serif', display: 'grid', gridTemplateRows: '48px 1fr' }}>
      <header style={{ borderBottom: '1px solid #1c2f2f', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 16px' }}>
        <strong>CrewCode Remote Preview</strong>
        <button onClick={onDisconnect} style={{ background: 'transparent', border: '1px solid #1c2f2f', color: '#d7e0dc', padding: '6px 10px' }}>Disconnect</button>
      </header>
      <div style={{ display: 'grid', gridTemplateColumns: '240px 280px 1fr', minHeight: 0 }}>
        <aside style={{ borderRight: '1px solid #1c2f2f', padding: 12, overflow: 'auto' }}>
          <div style={{ color: '#8da49a', fontSize: 12, marginBottom: 8 }}>WORKSPACES</div>
          {workspaces.map(workspace => <button key={workspace.id} onClick={() => void openWorkspace(workspace)} style={{ display: 'block', width: '100%', textAlign: 'left', background: selected?.id === workspace.id ? '#17241f' : 'transparent', border: 0, color: '#d7e0dc', padding: '8px 6px' }}>{workspace.name}</button>)}
        </aside>
        <aside style={{ borderRight: '1px solid #1c2f2f', padding: 12, overflow: 'auto' }}>
          <div style={{ color: '#8da49a', fontSize: 12, marginBottom: 8 }}>ROOT FILES</div>
          {nodes.map(node => <button key={node.rel} disabled={node.kind === 'dir'} onClick={() => void openFile(node)} style={{ display: 'block', width: '100%', textAlign: 'left', background: activeFile?.rel === node.rel ? '#17241f' : 'transparent', border: 0, color: node.kind === 'dir' ? '#8da49a' : '#d7e0dc', padding: '6px' }}>{node.kind === 'dir' ? '▸ ' : ''}{node.name}</button>)}
        </aside>
        <section style={{ minWidth: 0, display: 'grid', gridTemplateRows: '38px 1fr' }}>
          <div style={{ borderBottom: '1px solid #1c2f2f', padding: '6px 12px', color: '#8da49a', fontFamily: 'JetBrains Mono, monospace', fontSize: 11, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span>{status}</span>
            <span style={{ display: 'flex', gap: 8 }}>
              {selected && <button onClick={() => { setTerminalOpen(false); setChatOpen(true) }} style={{ background: '#285a48', border: '1px solid #1c2f2f', color: '#d7e0dc', padding: '4px 10px' }}>Chat</button>}
              {selected && <button onClick={() => void openTerminal()} style={{ background: 'transparent', border: '1px solid #1c2f2f', color: '#d7e0dc', padding: '4px 10px' }}>Terminal</button>}
              {activeFile && <button disabled={saving || activeFile.text === activeFile.savedText} onClick={() => void saveFile()} style={{ background: '#285a48', border: '1px solid #1c2f2f', color: '#d7e0dc', padding: '4px 10px' }}>{saving ? 'Saving…' : activeFile.text === activeFile.savedText ? 'Saved' : 'Save'}</button>}
            </span>
          </div>
          {chatOpen && selected ? <WebAgentChat workspacePath={selected.path} workspaceId={selected.id} onClose={() => setChatOpen(false)} /> : terminalOpen ? (
            <div style={{ display: 'grid', gridTemplateRows: '1fr 38px', minHeight: 0 }}>
              <pre style={{ margin: 0, padding: 16, overflow: 'auto', fontFamily: 'JetBrains Mono, monospace', fontSize: 13, whiteSpace: 'pre-wrap' }}>{terminalOutput}</pre>
              <input aria-label="Terminal input" placeholder="Type a command and press Enter" onKeyDown={event => { if (event.key === 'Enter') { getCrewCodeClient().ptyWrite(terminalPaneId.current, `${event.currentTarget.value}\r`); event.currentTarget.value = '' } }} style={{ border: 0, borderTop: '1px solid #1c2f2f', outline: 0, padding: '0 12px', background: '#131713', color: '#d7e0dc', fontFamily: 'JetBrains Mono, monospace' }} />
            </div>
          ) : activeFile
            ? <textarea aria-label={`Edit ${activeFile.rel}`} value={activeFile.text} onChange={event => setActiveFile(current => current ? { ...current, text: event.target.value } : current)} onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void saveFile() } }} spellCheck={false} style={{ resize: 'none', border: 0, outline: 0, margin: 0, padding: 16, overflow: 'auto', background: '#0f120f', color: '#d7e0dc', fontFamily: 'JetBrains Mono, monospace', fontSize: 13 }} />
            : <pre style={{ margin: 0, padding: 16, overflow: 'auto', fontFamily: 'JetBrains Mono, monospace', fontSize: 13, whiteSpace: 'pre-wrap' }}>Select a file to read it securely from the CrewCode server.</pre>}
        </section>
      </div>
    </main>
  )
}
