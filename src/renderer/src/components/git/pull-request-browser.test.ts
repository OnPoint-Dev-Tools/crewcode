import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const page = readFileSync(fileURLToPath(new URL('./GitPage.tsx', import.meta.url)), 'utf8')
const browser = readFileSync(fileURLToPath(new URL('./PullRequestBrowser.tsx', import.meta.url)), 'utf8')
const styles = readFileSync(fileURLToPath(new URL('../../styles/git-sidebar.css', import.meta.url)), 'utf8')

describe('repository pull request browser', () => {
  it('opens from Git Workspace and selects the current branch pull request', () => {
    expect(page).toContain('className="git-page-pr-browser-button"')
    expect(page).toContain('<PullRequestBrowser')
    expect(browser).toContain('item.head === currentBranch')
    expect(browser).toContain('githubPrCatalogue(repoPath)')
  })

  it('offers the requested filters and observed repository evidence', () => {
    expect(browser).toContain("['all', 'open', 'closed', 'assigned']")
    expect(browser).toContain('item.assignees, ...item.reviewers')
    expect(browser).toContain("['overview', 'timeline', 'changes', 'checks']")
    expect(browser).toContain('opened this pull request on')
    expect(browser).toContain('exactDateLabel(createdAt)')
    expect(browser).toContain('githubProfile(author)')
    expect(browser).toContain('githubAvatar(repoPath, avatarAuthor)')
    expect(browser).toContain('<img src={authorAvatar} alt="" />')
    expect(browser).toContain('<strong>Reviewers</strong>')
    expect(browser).toContain('<strong>Assignees</strong>')
    expect(browser).toContain('<strong>Labels</strong>')
  })

  it('shows explicit description sections, chronological evidence, and real patches', () => {
    expect(browser).toContain('Not provided in this pull request description.')
    expect(browser).toContain("kind: 'opened' as const")
    expect(browser).toContain(".sort((a, b) => a.at.localeCompare(b.at))")
    expect(browser).toContain('githubPrDiff(repoPath, selectedNumber)')
    expect(browser).toContain('splitPullRequestPatch(patch)')
    expect(browser).toContain('<PierreDiff patch={selectedPatch}')
  })

  it('owns checks and guarded mutation actions without target drift', () => {
    expect(browser).toContain("tab === 'checks'")
    expect(browser).toContain('const targetNumber = selected.number')
    expect(browser).toContain('disabled={actionLocked}')
    expect(browser).toContain('refreshSelectedEvidence(targetNumber)')
    expect(browser).toContain('Submit review')
    expect(browser).toContain('Update branch')
    expect(browser).toContain('Confirm close')
  })

  it('renders observed comments after the overview description sections', () => {
    const sectionsPosition = browser.indexOf('sections.map((section, index)')
    const commentsPosition = browser.indexOf('aria-label="Pull request comments"')
    expect(sectionsPosition).toBeGreaterThan(-1)
    expect(commentsPosition).toBeGreaterThan(sectionsPosition)
    expect(browser).toContain('comments.map(comment =>')
    expect(browser).toContain('No comments yet.')
    expect(browser).toContain('No written review summary.')
    expect(styles).toMatch(/\.pr-browser-conversation \.markdown-body \{[^}]*font-size: 13px/)
  })

  it('stacks the catalogue and details at the canonical phone breakpoint', () => {
    expect(styles).toContain('@media (max-width: 768px)')
    expect(styles).toContain('.pr-browser-layout { display: block; }')
    expect(styles).toContain('.pr-browser-search input { font-size: 16px; }')
    expect(styles).toContain('.pr-browser-changes { min-height: 72dvh; display: block; }')
  })

  it('keeps non-heading PR copy at a readable size', () => {
    expect(styles).toMatch(/\.pr-browser-section \.markdown-body \{[^}]*font-size: 13\.5px/)
    expect(styles).toMatch(/\.pr-browser-timeline \.markdown-body \{[^}]*font-size: 13px/)
    expect(styles).toMatch(/\.pr-description-block > div,[\s\S]*?font-size: 13\.5px/)
    expect(styles).toMatch(/\.pr-review-action-help \{[^}]*font-size: 10\.5px/)
  })

  it('supports exact-line pending reviews, threads, and file review progress', () => {
    expect(browser).toContain('githubPrReviewContext(repoPath, number)')
    expect(browser).toContain('onLineNumberClick={target =>')
    expect(browser).toContain('Add to review')
    expect(browser).toContain('Pending inline comments')
    expect(browser).toContain('comments: pendingComments.length ? pendingComments : undefined')
    expect(browser).toContain('Resolve conversation')
    expect(browser).toContain('Reopen conversation')
    expect(browser).toContain('ghPrReviewThread(repoPath, targetNumber, threadId, resolved)')
    expect(browser).toContain('ghPrViewedFile(repoPath, targetNumber')
    expect(browser).toContain('Local-only viewed state')
    expect(browser).toContain('Next unviewed')
    expect(browser).toContain('filesSinceLastReview')
  })

  it('manages pull requests in place and restores the browsing position', () => {
    expect(browser).toContain('browserMemoryByRepo.set(repoPath')
    expect(browser).toContain('githubPrManagementContext(repoPath, selectedNumber)')
    expect(browser).toContain('Edit title and description')
    expect(browser).toContain('Markdown description')
    expect(browser).toContain("changeMetadata('reviewer', 'add'")
    expect(browser).toContain("changeMetadata('assignee', 'remove'")
    expect(browser).toContain("changeMetadata('label', 'add'")
    expect(browser).toContain("setConfirmAction('draft')")
    expect(browser).toContain("setConfirmAction('reopen')")
    expect(browser).toContain("copyEvidence('PR URL'")
  })

  it('filters the bounded catalogue locally without additional GitHub reads', () => {
    expect(browser).toContain("reviewFilter === 'requested-to-you'")
    expect(browser).toContain("item.reviewDecision !== 'APPROVED'")
    expect(browser).toContain('item.labels.includes(labelFilter)')
    expect(browser).toContain('item.base !== baseFilter')
    expect(browser).toContain('item.head !== headFilter')
  })

  it('shows detailed check evidence and exact-head merge automation', () => {
    expect(browser).toContain('githubPrChecksContext(repoPath, number)')
    expect(browser).toContain('githubPrCheckLog(repoPath, selectedNumber, checksContext.headCommitId')
    expect(browser).toContain('Merge requirements')
    expect(browser).toContain('check.steps.map')
    expect(browser).toContain('check.annotations.map')
    expect(browser).toContain('Load job log')
    expect(browser).toContain('Rerun failed jobs')
    expect(browser).toContain('Confirm rerun')
    expect(browser).toContain('Could not load current merge requirements')
    expect(browser).toContain("performMergeAutomation('enable')")
    expect(browser).toContain("performMergeAutomation('queue')")
    expect(browser).toContain('onMerge?.(number, mergeMethod, checksContext?.headCommitId)')
    expect(styles).toContain('.pr-check-merge-readiness')
    expect(styles).toContain('.pr-check-log pre')
  })
})
