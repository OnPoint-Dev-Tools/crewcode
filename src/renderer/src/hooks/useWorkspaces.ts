import { useState, useEffect, useCallback } from 'react'
import type { Workspace, StoredWorkspace, Worktree } from '../types'
import { getCrewCodeClient } from '../runtime/crewcode-client'

function toWorkspace(s: StoredWorkspace, worktrees: Worktree[] = []): Workspace {
  return {
    id:        s.id,
    name:      s.name,
    path:      s.path,
    branch:    s.branch,
    dirty:     s.dirty,
    status:    s.status,
    kind:      s.kind,
    pinned:    s.pinned,
    folder:    s.folder ?? null,
    agents:             s.agents,
    updated:            s.updated,
    projectIconDataUrl: s.projectIconDataUrl ?? null,
    worktrees,
    github:             null,
  }
}

export function useWorkspaces() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [loading,    setLoading]    = useState(true)

  const reload = useCallback(async () => {
    const api = getCrewCodeClient()
    const list = await api.workspacesList()
    setWorkspaces(list.map(s => toWorkspace(s)))
    setLoading(false)
    // Fetch worktrees for each workspace in parallel; merge as each one resolves so the
    // drawer can show worktrees without the user needing to click refresh.
    await Promise.all(list.map(async (s) => {
      try {
        const r = await api.worktreeList(s.path)
        if (r.worktrees) {
          setWorkspaces(prev => prev.map(w => w.id === s.id ? { ...w, worktrees: r.worktrees! } : w))
        }
      } catch {
        /* ignore — workspace may not be a git repo */
      }
    }))
  }, [])

  useEffect(() => { reload() }, [reload])

  const addByPath = useCallback(async (path: string) => {
    const api = getCrewCodeClient()
    const result = await api.workspacesAdd(path)
    if (result.error || !result.workspace) return null
    await reload()
    return result.workspace.id
  }, [reload])

  const addViaPicker = useCallback(async () => {
    const api = getCrewCodeClient()
    const picked = await api.workspacesPickFolder()
    if (picked.canceled || !picked.path) return null
    return addByPath(picked.path)
  }, [addByPath])

  const cloneRepo = useCallback(async (url: string, parentDir: string, folderName?: string) => {
    const api = getCrewCodeClient()
    const result = await api.workspacesCloneRepo(url, parentDir, folderName)
    if (result.error || !result.path) return { error: result.error ?? 'clone failed' }
    const id = await addByPath(result.path)
    return id ? { id } : { error: 'clone succeeded but failed to add workspace' }
  }, [addByPath])

  const initProject = useCallback(async (parentDir: string, folderName: string, asGit: boolean) => {
    const api = getCrewCodeClient()
    const result = await api.workspacesInitProject(parentDir, folderName, asGit)
    if (result.error || !result.path) return { error: result.error ?? 'init failed' }
    const id = await addByPath(result.path)
    return id ? { id } : { error: 'created but failed to add workspace' }
  }, [addByPath])

  // Remote add must go through the hook (not call IPC directly) so the
  // in-memory list reloads before App activates the new workspace id.
  const addRemote = useCallback(async (opts: { host: string; user?: string; port?: number; path: string; name?: string }) => {
    const api = getCrewCodeClient()
    const result = await api.workspacesAddRemote(opts)
    if (result.error || !result.workspace) return { error: result.error ?? 'could not add remote' }
    await reload()
    return { id: result.workspace.id }
  }, [reload])

  const pickFolder = useCallback(async () => {
    const api = getCrewCodeClient()
    const picked = await api.workspacesPickFolder()
    if (picked.canceled || !picked.path) return null
    return picked.path
  }, [])

  const remove = useCallback(async (id: string) => {
    const api = getCrewCodeClient()
    await api.workspacesRemove(id)
    await reload()
  }, [reload])

  const togglePin = useCallback(async (id: string, pinned: boolean) => {
    const api = getCrewCodeClient()
    await api.workspacesPin(id, pinned)
    await reload()
  }, [reload])

  const rename = useCallback(async (id: string, name: string) => {
    const api = getCrewCodeClient()
    const r = await api.workspacesRename(id, name)
    if (r.error) return { error: r.error }
    await reload()
    return { ok: true }
  }, [reload])

  const setFolder = useCallback(async (id: string, folder: string | null) => {
    const api = getCrewCodeClient()
    await api.workspacesSetFolder(id, folder)
    await reload()
  }, [reload])

  const refreshWorktrees = useCallback(async (wsId: string) => {
    const api = getCrewCodeClient()
    const ws = workspaces.find(w => w.id === wsId)
    if (!ws) return
    const result = await api.worktreeList(ws.path)
    if (!result.worktrees) return
    setWorkspaces(prev => prev.map(w => w.id === wsId ? { ...w, worktrees: result.worktrees! } : w))
  }, [workspaces])

  const createWorktree = useCallback(async (wsId: string, branch: string, startPoint?: string) => {
    const api = getCrewCodeClient()
    const ws = workspaces.find(w => w.id === wsId)
    if (!ws) return { error: 'workspace not found' }
    const result = await api.worktreeCreate(ws.path, branch, undefined, startPoint)
    if (result.error || !result.path) return { error: result.error ?? 'worktree create failed' }
    // Re-list so we can hand back the created worktree object — crew lane
    // provisioning needs its id (derived from the path by main) immediately,
    // and reading state after the await would be a stale closure.
    const listed = await api.worktreeList(ws.path)
    if (listed.worktrees) {
      setWorkspaces(prev => prev.map(w => w.id === wsId ? { ...w, worktrees: listed.worktrees! } : w))
    }
    const worktree = listed.worktrees?.find(w => w.path === result.path) ?? null
    return { ok: true, path: result.path, worktree }
  }, [workspaces])

  const deleteWorktree = useCallback(async (wsId: string, wtId: string) => {
    const api = getCrewCodeClient()
    const ws = workspaces.find(w => w.id === wsId)
    if (!ws) return { error: 'workspace not found' }
    const wt = ws.worktrees.find(w => w.id === wtId)
    if (!wt) return { error: 'worktree not found' }
    const result = await api.worktreeRemove(wt.path)
    if (result.error) return { error: result.error }
    await refreshWorktrees(wsId)
    return { ok: true }
  }, [workspaces, refreshWorktrees])

  return { workspaces, loading, reload, addByPath, addViaPicker, pickFolder, cloneRepo, initProject, addRemote, remove, togglePin, rename, setFolder, refreshWorktrees, createWorktree, deleteWorktree }
}
