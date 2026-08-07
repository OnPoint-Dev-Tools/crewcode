import electron from 'electron'
import { join } from 'path'
import { WorkspaceService, type AddRemoteWorkspaceOptions } from './workspace-service'

const { app, ipcMain, dialog, BrowserWindow } = electron

function workspaceService(): WorkspaceService {
  return new WorkspaceService(join(app.getPath('userData'), 'workspaces.json'))
}

/** Electron transport adapter. Domain behavior lives in WorkspaceService so the
 * headless web server can use it without loading Electron. */
export function registerWorkspaceIpc(): void {
  const service = workspaceService()
  ipcMain.handle('workspaces:list', () => service.list())
  ipcMain.handle('workspaces:add', (_event, path: string) => service.add(path))
  ipcMain.handle('workspaces:addRemote', (_event, opts: AddRemoteWorkspaceOptions) => service.addRemote(opts))
  ipcMain.handle('workspaces:remove', (_event, id: string) => service.remove(id))
  ipcMain.handle('workspaces:pin', (_event, id: string, pinned: boolean) => service.pin(id, pinned))
  ipcMain.handle('workspaces:rename', (_event, id: string, name: string) => service.rename(id, name))
  ipcMain.handle('workspaces:setFolder', (_event, id: string, folder: string | null) => service.setFolder(id, folder))
  ipcMain.handle('workspaces:cloneRepo', (_event, url: string, parentDir: string, folderName?: string) =>
    service.cloneRepo(url, parentDir, folderName))
  ipcMain.handle('workspaces:initProject', (_event, parentDir: string, folderName: string, asGit: boolean) =>
    service.initProject(parentDir, folderName, asGit))

  ipcMain.handle('directories:pickExternal', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined
    const result = await dialog.showOpenDialog(win!, {
      title: 'Attach external directory to this session',
      properties: ['openDirectory', 'createDirectory'],
    })
    if (result.canceled || result.filePaths.length === 0) return { canceled: true }
    return { ok: true, path: result.filePaths[0] }
  })

  ipcMain.handle('workspaces:pickFolder', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined
    const result = await dialog.showOpenDialog(win!, {
      title: 'add workspace',
      properties: ['openDirectory', 'createDirectory'],
    })
    if (result.canceled || result.filePaths.length === 0) return { canceled: true }
    return { ok: true, path: result.filePaths[0] }
  })
}
