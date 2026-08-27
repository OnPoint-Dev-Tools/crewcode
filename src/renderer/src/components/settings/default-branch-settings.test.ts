import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const settingsHook = readFileSync(fileURLToPath(new URL('../../hooks/useSettings.tsx', import.meta.url)), 'utf8')
const settingsScreen = readFileSync(fileURLToPath(new URL('./SettingsScreen.tsx', import.meta.url)), 'utf8')
const sessions = readFileSync(fileURLToPath(new URL('../../hooks/useChatSessions.ts', import.meta.url)), 'utf8')
const app = readFileSync(fileURLToPath(new URL('../../App.tsx', import.meta.url)), 'utf8')

describe('workspace default branch', () => {
  it('persists a workspace-scoped default and lists detected branches', () => {
    expect(settingsHook).toContain('defaultBranchByWorkspace: Record<string, string>')
    expect(settingsHook).toContain('defaultBranchByWorkspace: {}')
    expect(settingsScreen).toContain('window.electronAPI?.gitBranches(workspace.path)')
    expect(settingsScreen).toContain('<div className="label">Default branch</div>')
    expect(settingsScreen).toContain('Git Workspace and Git Sidebar also compare')
    expect(settingsScreen).toContain("set('defaultBranchByWorkspace', next)")
  })

  it('captures the selected default only when a session is created', () => {
    expect(sessions).toContain('initialBranch: d.initialBranch?.trim() || undefined')
    expect(app).toContain('initialBranch: settings.defaultBranchByWorkspace[activeWs] ??')
    expect(app).toContain("worktreeSelectionKey(session.tabId, 'chat', session.id)")
  })

  it('uses the selected branch as the Git comparison base', () => {
    expect(app).toContain('comparisonRef:     settings.defaultBranchByWorkspace[activeWs]?.trim() || undefined')
    expect(app).toContain('api.gitDiffVsRef(effectivePath, comparisonRef, path)')
  })

  it('selects or provisions the matching worktree and then clears the request', () => {
    expect(app).toContain('workspace.worktrees.find(candidate => candidate.branch === branch)')
    expect(app).toContain('worktreeCreate(workspace.path, branch)')
    expect(app).toContain('{ initialBranch: undefined }')
    expect(sessions).toContain('initialBranch: undefined,')
  })
})
