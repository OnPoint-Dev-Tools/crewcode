import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const sidebar = readFileSync(fileURLToPath(new URL('./GitSidebar.tsx', import.meta.url)), 'utf8')
const modal = readFileSync(fileURLToPath(new URL('./PullRequestModal.tsx', import.meta.url)), 'utf8')
const review = readFileSync(fileURLToPath(new URL('./PullRequestReview.tsx', import.meta.url)), 'utf8')
const hook = readFileSync(fileURLToPath(new URL('../../hooks/useGitSidebar.ts', import.meta.url)), 'utf8')

describe('in-app pull request card', () => {
  it('creates pull requests without opening the returned GitHub URL', () => {
    expect(modal).toContain('Create pull request')
    expect(modal).toContain('Create as draft')
    expect(modal).toContain("const STEPS = ['Branches', 'Details', 'Review']")
    expect(modal).toContain('githubPrCreateContext(repoPath, base.trim())')
    expect(hook).toContain('ghPrCreate(repoPath, options)')
    expect(hook).not.toContain('firstWebUrl')
  })

  it('offers every supported merge method behind explicit confirmation', () => {
    expect(review).toContain('<option value="merge">Create merge commit</option>')
    expect(review).toContain('<option value="squash">Squash and merge</option>')
    expect(review).toContain('<option value="rebase">Rebase and merge</option>')
    expect(review).toContain('Confirm merge')
  })

  it('keeps common review actions in the card', () => {
    expect(sidebar).toContain('Review in CrewCode')
    expect(review).toContain('Submit review')
    expect(review).toContain('Request changes')
    expect(review).toContain('Close pull request')
    expect(review).toContain('<PierreDiff patch={selectedPatch}')
  })
})
