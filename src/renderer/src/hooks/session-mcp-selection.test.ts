import { describe, expect, it } from 'vitest'

import type { McpServerConfig } from './useSettings'
import { resolveSessionMcpServers, mergeMcpServers } from './session-mcp-selection'

const fs: McpServerConfig = { id: 'fs', name: 'filesystem', command: 'npx', args: ['-y', 'srv-fs'] }
const git: McpServerConfig = { id: 'git', name: 'git', command: 'mcp-git' }
const registry = [fs, git]

describe('resolveSessionMcpServers', () => {
  it('returns nothing when the global toggle is off, even with a selection', () => {
    expect(resolveSessionMcpServers(false, registry, ['fs', 'git'])).toEqual([])
  })

  it('returns only the selected servers when enabled', () => {
    expect(resolveSessionMcpServers(true, registry, ['git'])).toEqual([git])
  })

  it('drops selected ids no longer in the registry', () => {
    expect(resolveSessionMcpServers(true, registry, ['fs', 'ghost'])).toEqual([fs])
  })

  it('returns [] for an empty or missing selection', () => {
    expect(resolveSessionMcpServers(true, registry, [])).toEqual([])
    expect(resolveSessionMcpServers(true, registry, undefined)).toEqual([])
  })

  it('orders by the registry, not the selection', () => {
    // Selection lists git first, but registry order (fs, git) wins for stability.
    expect(resolveSessionMcpServers(true, registry, ['git', 'fs'])).toEqual([fs, git])
  })
})

describe('mergeMcpServers', () => {
  const appFs: McpServerConfig = { id: 'fs', name: 'app filesystem', command: 'app-fs' }
  const fileFs: McpServerConfig = { id: 'fs', name: 'file filesystem', command: 'file-fs' }
  const fileGit: McpServerConfig = { id: 'git', name: 'git', command: 'mcp-git' }

  it('keeps app servers first, then file servers not already present', () => {
    expect(mergeMcpServers([appFs], [fileGit])).toEqual([appFs, fileGit])
  })

  it('lets app entries win on id collision', () => {
    expect(mergeMcpServers([appFs], [fileFs, fileGit])).toEqual([appFs, fileGit])
  })

  it('handles empty inputs', () => {
    expect(mergeMcpServers([], [])).toEqual([])
    expect(mergeMcpServers([], [fileGit])).toEqual([fileGit])
  })
})
