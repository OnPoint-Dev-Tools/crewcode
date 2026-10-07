import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { BrainWorkspaceAccess, Workspace } from '../../types'
import { WorkspaceRow } from './WorkspaceRow'

function workspace(brainAccess: BrainWorkspaceAccess): Workspace {
  return {
    id: 'project',
    name: 'Project',
    path: '/workspace/project',
    branch: null,
    dirty: 0,
    status: brainAccess === 'authorized' ? 'idle' : 'error',
    kind: 'folder',
    pinned: false,
    folder: null,
    agents: [],
    updated: '',
    worktrees: [],
    github: null,
    brainAccess,
  }
}

describe('WorkspaceRow Brain access state', () => {
  it('keeps registered but unauthorized projects visible and locked', () => {
    const html = renderToStaticMarkup(React.createElement(WorkspaceRow, {
      ws: workspace('requires-authorization'), active: false, onClick: () => undefined,
    }))

    expect(html).toContain('disabled=""')
    expect(html).toContain('AUTHORIZE')
    expect(html).toContain('Settings → Brain Access')
  })

  it('labels SSH projects as desktop-only', () => {
    const value = { ...workspace('desktop-only'), kind: 'remote' as const, path: 'ssh://devbox/srv/app' }
    const html = renderToStaticMarkup(React.createElement(WorkspaceRow, {
      ws: value, active: false, onClick: () => undefined,
    }))

    expect(html).toContain('disabled=""')
    expect(html).toContain('DESKTOP')
  })

  it('keeps authorized projects interactive', () => {
    const html = renderToStaticMarkup(React.createElement(WorkspaceRow, {
      ws: workspace('authorized'), active: false, onClick: () => undefined,
    }))

    expect(html).not.toContain('disabled=""')
    expect(html).toContain('LOCAL')
  })
})
