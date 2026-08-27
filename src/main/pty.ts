import { ipcMain, webContents } from 'electron'
import { PtyService, detectShells, type PtyCreateOpts, type PtyDaemon } from './pty-service'
import { startYuHeardServer } from './yuheard-server'
import { pruneYuHeardWrappers } from './yuheard-wrapper'

export type { PtyCreateOpts, PtyDaemon } from './pty-service'

const service = new PtyService()
const owners = new Map<string, number>()

service.subscribe(event => {
  const owner = owners.get(event.paneId)
  if (owner === undefined) return
  if (event.type === 'data') webContents.fromId(owner)?.send('pty:data', { paneId: event.paneId, data: event.data })
  else {
    webContents.fromId(owner)?.send('pty:exit', { paneId: event.paneId, exitCode: event.exitCode, signal: event.signal })
    owners.delete(event.paneId)
  }
})

/** Electron transport adapter for the reusable PTY service. */
export function registerPtyIpc(): void {
  // Start the YuHeard socket server with this PtyService as the registry.
  // Lazy and idempotent; failure is non-fatal (the rest of the app works).
  try {
    startYuHeardServer(service)
    pruneYuHeardWrappers()
  } catch { /* non-fatal */ }
  ipcMain.handle('shells:detect', () => detectShells())
  ipcMain.handle('pty:create', (event, opts: PtyCreateOpts) => {
    owners.set(opts.paneId, event.sender.id)
    const result = service.create(opts)
    if (result.error) owners.delete(opts.paneId)
    return result
  })
  ipcMain.on('pty:write', (_event, { paneId, data }: { paneId: string; data: string }) => service.write(paneId, data))
  ipcMain.on('pty:resize', (_event, { paneId, cols, rows }: { paneId: string; cols: number; rows: number }) => service.resize(paneId, cols, rows))
  ipcMain.on('pty:kill', (_event, paneId: string) => { service.kill(paneId); owners.delete(paneId) })
}

export function killAllPanes(): void { service.killAll(); owners.clear() }
export function ptyProcessCount(): number { return service.processCount() }
export function listPtyDaemons(): PtyDaemon[] { return service.listDaemons() }
