import { describe, expect, it } from 'vitest'

import { workspaceDisplayPath } from './workspace-display-path'

describe('workspaceDisplayPath', () => {
  it('replaces a POSIX home prefix with a tilde', () => {
    expect(workspaceDisplayPath(
      '/home/aura/developing/DEV-TOOLS/CrewCode',
      '/home/aura',
    )).toBe('~/developing/DEV-TOOLS/CrewCode')
  })

  it('handles Windows paths case-insensitively and normalizes display separators', () => {
    expect(workspaceDisplayPath(
      'C:\\Users\\Aura\\developing\\CrewCode',
      'c:\\users\\aura',
    )).toBe('~/developing/CrewCode')
  })

  it('requires a path boundary after the home directory', () => {
    expect(workspaceDisplayPath('/home/aura2/project', '/home/aura')).toBe('/home/aura2/project')
  })

  it('leaves SSH roots unchanged', () => {
    const remote = 'ssh://dev@example.com/home/dev/project'
    expect(workspaceDisplayPath(remote, '/home/aura')).toBe(remote)
  })
})
