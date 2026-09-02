import { describe, expect, it, vi } from 'vitest'

import { getGhStatus, getGitHubStatus, getPullRequestCreateContext, getPullRequestDetail, getPullRequestDiff, pullRequestActionArgs, pullRequestCommentArgs, pullRequestCreateArgs, pullRequestMergeArgs, pullRequestReviewArgs, type GitHubCommandRunner } from './github-service'

function result(stdout = '', status = 0, stderr = '') {
  return { status, stdout, stderr }
}

describe('non-blocking GitHub status', () => {
  it('collects repository status through the async command runner', async () => {
    const run: GitHubCommandRunner = vi.fn(async (command, args) => {
      const key = `${command} ${args.slice(0, 2).join(' ')}`
      if (key === 'git remote get-url') return result('git@github.com:crewcode/app.git\n')
      if (key === 'gh pr list') return result('[{"number":7,"title":"Fix","headRefName":"fix","baseRefName":"dev","state":"OPEN","url":"https://github.com/crewcode/app/pull/7","isDraft":false,"author":{"login":"CjLogix"},"updatedAt":"2026-08-28T20:00:00Z","body":"Fixes CI","mergeStateStatus":"BEHIND","reviewDecision":"REVIEW_REQUIRED"}]')
      if (key === 'gh run list') return result('[{"databaseId":9,"name":"test","status":"completed","conclusion":"success","headBranch":"fix"}]')
      if (key === 'gh issue list') return result('[{"number":1},{"number":2}]')
      return result('gh version 1')
    })

    await expect(getGitHubStatus('/repo', run)).resolves.toEqual({
      owner: 'crewcode',
      repo: 'app',
      prs: [{
        number: 7, title: 'Fix', state: 'OPEN', branch: 'fix', base: 'dev',
        url: 'https://github.com/crewcode/app/pull/7', isDraft: false, author: 'CjLogix',
        updatedAt: '2026-08-28T20:00:00Z', body: 'Fixes CI', mergeStateStatus: 'BEHIND',
        reviewDecision: 'REVIEW_REQUIRED',
      }],
      runs: [{ id: 9, name: 'test', status: 'completed', conclusion: 'success', branch: 'fix' }],
      issues: 2,
    })
  })

  it('builds explicit create and merge commands without browser handoff', () => {
    expect(pullRequestCreateArgs({ title: ' Fix CI ', body: ' Verified ', base: 'dev', draft: true })).toEqual([
      'pr', 'create', '--title', 'Fix CI', '--base', 'dev', '--body', 'Verified', '--draft',
    ])
    expect(pullRequestMergeArgs(7, 'merge')).toEqual(['pr', 'merge', '7', '--merge'])
    expect(pullRequestMergeArgs(7, 'squash')).toEqual(['pr', 'merge', '7', '--squash'])
    expect(pullRequestMergeArgs(7, 'rebase')).toEqual(['pr', 'merge', '7', '--rebase'])
    expect(pullRequestActionArgs('update-branch', 7)).toEqual(['pr', 'update-branch', '7'])
    expect(pullRequestCommentArgs(7, ' Looks good ')).toEqual(['pr', 'comment', '7', '--body', 'Looks good'])
    expect(() => pullRequestCommentArgs(7, ' ')).toThrow('Comment is required')
    expect(pullRequestReviewArgs(7, { event: 'approve', body: 'Ship it' })).toEqual(['pr', 'review', '7', '--approve', '--body', 'Ship it'])
    expect(pullRequestReviewArgs(7, { event: 'request-changes', body: 'Please add coverage' })).toEqual(['pr', 'review', '7', '--request-changes', '--body', 'Please add coverage'])
    expect(() => pullRequestReviewArgs(7, { event: 'comment' })).toThrow('Review comment is required')
    expect(() => pullRequestMergeArgs(7, 'invalid' as 'merge')).toThrow('Unsupported pull request merge method')
  })

  it('measures creation context against the selected base without mutating refs', async () => {
    const run: GitHubCommandRunner = vi.fn(async (command, args) => {
      if (command !== 'git') return result('', 1)
      if (args[0] === 'branch') return result('feature\n')
      if (args[0] === 'rev-list') return result('2\t4\n')
      if (args[0] === 'diff') return result('src/a.ts\nsrc/b.ts\n')
      if (args[0] === 'merge-base') return result('abc123\n')
      if (args[0] === 'merge-tree') return result('merged cleanly\n')
      return result('', 1)
    })

    await expect(getPullRequestCreateContext('/repo', 'main', run)).resolves.toEqual({
      head: 'feature', base: 'main', ahead: 4, behind: 2, changedFiles: 2, mergeStatus: 'clean',
    })
    expect(run).toHaveBeenCalledWith('git', ['merge-tree', 'abc123', 'main', 'HEAD'], '/repo')
  })

  it('loads normalized review evidence and the real pull-request patch', async () => {
    const payload = {
      number: 7, title: 'Fix CI', state: 'OPEN', url: 'https://github.com/o/r/pull/7', isDraft: false,
      author: { login: 'cj' }, body: 'Details', headRefName: 'fix', baseRefName: 'main', mergeStateStatus: 'CLEAN',
      reviewDecision: 'REVIEW_REQUIRED', additions: 8, deletions: 3,
      files: [{ path: 'src/a.ts', additions: 8, deletions: 3 }],
      commits: [{ oid: 'abcdef123', messageHeadline: 'Fix it', committedDate: '2026-08-28T20:00:00Z', authors: [{ login: 'cj' }] }],
      comments: [{ id: 'c1', author: { login: 'reviewer' }, body: 'Question', createdAt: '2026-08-28T21:00:00Z' }],
      reviews: [{ id: 'r1', author: { login: 'lead' }, body: 'Looks close', state: 'COMMENTED', submittedAt: '2026-08-28T22:00:00Z' }],
      statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'https://github.com/check' }],
    }
    const patch = 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n'
    const run: GitHubCommandRunner = vi.fn(async (_command, args) => args[1] === 'view' ? result(JSON.stringify(payload)) : result(patch))

    await expect(getPullRequestDetail('/repo', 7, run)).resolves.toMatchObject({
      number: 7, head: 'fix', base: 'main', additions: 8, deletions: 3,
      files: [{ path: 'src/a.ts', additions: 8, deletions: 3 }],
      commits: [{ oid: 'abcdef123', message: 'Fix it', author: 'cj' }],
      comments: [expect.objectContaining({ id: 'c1', kind: 'comment' }), expect.objectContaining({ id: 'r1', kind: 'review', state: 'COMMENTED' })],
      checks: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'https://github.com/check' }],
    })
    await expect(getPullRequestDiff('/repo', 7, run)).resolves.toEqual({ ok: true, patch })
  })

  it('reports gh authentication without synchronous process calls', async () => {
    const run: GitHubCommandRunner = vi.fn(async (_command, args) => args[0] === '--version'
      ? result('gh version 1')
      : result('', 0, 'Logged in to github.com as CjLogix'))

    await expect(getGhStatus(run)).resolves.toMatchObject({
      available: true,
      loggedIn: true,
      user: 'CjLogix',
      host: 'github.com',
    })
  })
})
