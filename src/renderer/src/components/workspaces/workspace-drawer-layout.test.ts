import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const drawerPath = fileURLToPath(new URL('./WorkspacesDrawer.tsx', import.meta.url))
const drawer = readFileSync(drawerPath, 'utf8')

describe('workspace drawer layout', () => {
  it('renders activity before workspace groups and selected-workspace threads', () => {
    const workingSection = drawer.indexOf('id="__working_chats"')
    const completedSection = drawer.indexOf('id="__recent_chats"')
    const pinnedSection = drawer.indexOf('id="__pinned"')
    const projectsSection = drawer.indexOf('id="__recent"')
    const selectedThreads = drawer.indexOf('{renderSelectedWorkspaceThreads()}')

    expect(workingSection).toBeGreaterThan(-1)
    expect(completedSection).toBeGreaterThan(workingSection)
    expect(pinnedSection).toBeGreaterThan(completedSection)
    expect(projectsSection).toBeGreaterThan(completedSection)
    expect(selectedThreads).toBeGreaterThan(projectsSection)
  })

  it('keeps sessions out of individual workspace rows', () => {
    const workspaceRowStart = drawer.indexOf('function renderWorkspaceRow')
    const selectedThreadsStart = drawer.indexOf('function renderSelectedWorkspaceThreads')
    const workspaceRowRenderer = drawer.slice(workspaceRowStart, selectedThreadsStart)

    expect(workspaceRowRenderer).not.toContain('<Sessions')
    expect(workspaceRowRenderer).not.toContain('hasWorktrees=')
    expect(drawer).not.toContain('renderWorkspaceBlock')
  })

  it('labels the session list with the active workspace', () => {
    expect(drawer).toContain('label={`THREADS · ${ws.name}`}')
    expect(drawer).toContain('const ws = workspaces.find(workspace => workspace.id === active)')
  })

  it('gives every drawer section a recognizable icon', () => {
    for (const icon of ['app', 'pin', 'folder', 'projects', 'globe', 'bolt', 'check', 'terminal', 'threads', 'listTree']) {
      expect(drawer).toContain(`icon="${icon}"`)
    }
  })

  it('formats workspace paths with the local home directory', () => {
    expect(drawer).toContain('window.electronAPI?.appHomePath()')
    expect(drawer).toContain('displayPath={workspaceDisplayPath(ws.path, homePath)}')
  })

  it('filters expired Completed shortcuts without removing sessions', () => {
    expect(drawer).toContain('isCompletedChatShortcutVisible(c.completedAt, now)')
    expect(drawer).toContain('const unexpiredChats = completedChats.filter')
  })

  it('pins chats within their existing thread groups', () => {
    expect(drawer).toContain('const ownSessions = pinnedSessionsFirst([...own].reverse())')
    expect(drawer).toContain('const delegatedSessions = pinnedSessionsFirst(delegated)')
    expect(drawer).toContain("session.pinned ? 'Unpin chat' : 'Pin chat'")
    expect(drawer).toContain('onSessionTogglePin(session)')
  })
})
