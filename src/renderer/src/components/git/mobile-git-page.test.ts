import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const page = readFileSync(fileURLToPath(new URL('./GitPage.tsx', import.meta.url)), 'utf8')
const changes = readFileSync(fileURLToPath(new URL('./GitPageChanges.tsx', import.meta.url)), 'utf8')
const styles = readFileSync(fileURLToPath(new URL('../../styles/git-sidebar.css', import.meta.url)), 'utf8')

describe('mobile Git Workspace', () => {
  it('keeps the shared Git state and active-worktree diff route', () => {
    expect(page).toContain('<GitSidebar {...props}')
    expect(page).toContain('repoPath={workspace.path}')
    expect(changes).toContain('client.gitDiffVsRef(repoPath, comparisonRef, selected.path)')
    expect(changes).toContain('client.gitDiff(repoPath, selected.path, selected.staged)')
  })

  it('uses the canonical phone breakpoint and stacks changes above the diff', () => {
    expect(styles).not.toContain('@media (max-width: 760px)')
    expect(styles).toContain('@media (max-width: 768px)')
    expect(styles).toContain('.git-page-main { height: min(620px, 78dvh); min-height: min(620px, 78dvh); }')
    expect(styles).toContain('max-height: min(260px, 34dvh);')
    expect(styles).toContain('grid-template-columns: 1fr;')
    expect(styles).toContain('.git-page-overview > .git-page-card-row { display: contents; }')
  })

  it('provides touch-sized actions and iOS-safe Git inputs', () => {
    expect(styles).toContain('.git-page-more { width: 36px; height: 36px; }')
    expect(styles).toContain('min-height: 36px;\n    max-width: min(55vw, 300px);')
    expect(styles).toContain('.git-page-commit textarea { font-size: 16px; }')
    expect(styles).toContain('.gs-pop-search input,\n  .gb-input-wrap input { font-size: 16px; }')
    expect(styles).toContain('.gs-menu-item,\n  .gs-pop-item { min-height: 40px; }')
  })
})
