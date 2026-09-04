import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const sidebar = readFileSync(fileURLToPath(new URL('./GitSidebar.tsx', import.meta.url)), 'utf8')
const modal = readFileSync(fileURLToPath(new URL('./PullRequestModal.tsx', import.meta.url)), 'utf8')
const browser = readFileSync(fileURLToPath(new URL('./PullRequestBrowser.tsx', import.meta.url)), 'utf8')
const hook = readFileSync(fileURLToPath(new URL('../../hooks/useGitSidebar.ts', import.meta.url)), 'utf8')

describe('in-app pull request card', () => {
  it('creates pull requests without opening the returned GitHub URL', () => {
    expect(modal).toContain('Create pull request')
    expect(modal).toContain('Create as draft')
    expect(modal).toContain("const STEPS = ['Branches', 'Details', 'Review']")
    expect(modal).toContain('githubPrCreateContext(repoPath, base.trim())')
    expect(modal).toContain('Pick commits')
    expect(modal).toContain('selectedCommits: commitScope')
    expect(modal).toContain('isolated worktree')
    expect(modal).toContain("label: 'Description'")
    expect(modal).toContain("label: 'Problem'")
    expect(modal).toContain("label: 'What changed'")
    expect(modal).toContain("label: 'Why it changed'")
    expect(modal).toContain("label: 'Solution'")
    expect(modal).toContain('buildPullRequestBody(bodyValues)')
    expect(hook).toContain('ghPrCreate(repoPath, options)')
    expect(hook).not.toContain('firstWebUrl')
  })

  it('offers every supported merge method behind explicit confirmation', () => {
    expect(browser).toContain('<option value="merge">Create merge commit</option>')
    expect(browser).toContain('<option value="squash">Squash and merge</option>')
    expect(browser).toContain('<option value="rebase">Rebase and merge</option>')
    expect(browser).toContain('Confirm merge')
    expect(browser).toContain('Mark ready for review')
    expect(browser).toContain('Draft pull requests cannot be merged.')
    expect(browser).toContain('Merge #{selected?.number}')
  })

  it('keeps common review actions in the canonical browser workspace', () => {
    expect(sidebar).toContain('Open PR workspace')
    expect(sidebar).toContain('<PullRequestBrowser')
    expect(sidebar).not.toContain('<PullRequestReview')
    expect(browser).toContain('Submit review')
    expect(browser).toContain('Request changes')
    expect(browser).toContain('Write a review summary before submitting.')
    expect(browser).toContain('GitHub does not allow an author to approve their own pull request.')
    expect(browser).toContain('Resolve conflicts in CrewCode')
    expect(browser).toContain('It refuses a different branch or any uncommitted changes.')
    expect(sidebar).toContain('onOpenFile?.(c.path)')
    expect(browser).toContain('Close pull request')
    expect(browser).toContain('<PierreDiff patch={selectedPatch}')
  })
})
