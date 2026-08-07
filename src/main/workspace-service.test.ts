import { mkdtempSync, mkdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { describe, expect, it } from 'vitest'
import { WorkspaceService } from './workspace-service'

function fixture(): { root: string; service: WorkspaceService } {
  const root = mkdtempSync(join(tmpdir(), 'crewcode-workspaces-'))
  return { root, service: new WorkspaceService(join(root, 'state', 'workspaces.json')) }
}

describe('WorkspaceService', () => {
  it('persists local workspace mutations without Electron', () => {
    const { root, service } = fixture()
    const project = join(root, 'project')
    mkdirSync(project)
    const added = service.add(project)
    expect(added.ok).toBe(true)
    expect(service.rename(added.workspace!.id, 'renamed')).toEqual({ ok: true })
    expect(service.pin(added.workspace!.id, true)).toEqual({ ok: true })
    expect(service.setFolder(added.workspace!.id, 'backend')).toEqual({ ok: true })
    expect(service.list()[0]).toMatchObject({ name: 'renamed', pinned: true, folder: 'backend', path: project })
    expect(JSON.parse(readFileSync(join(root, 'state', 'workspaces.json'), 'utf8')).workspaces).toHaveLength(1)
  })

  it('validates remote roots and deduplicates them', () => {
    const { service } = fixture()
    expect(service.addRemote({ host: '', path: '/srv/app' }).error).toBe('host is required')
    expect(service.addRemote({ host: 'devbox', path: 'relative' }).error).toBe('an absolute remote path is required')
    const first = service.addRemote({ host: 'devbox', user: 'cj', path: '/srv/app' })
    const second = service.addRemote({ host: 'devbox', user: 'cj', path: '/srv/app' })
    expect(first.workspace?.id).toBe(second.workspace?.id)
    expect(service.list()).toHaveLength(1)
  })
})
