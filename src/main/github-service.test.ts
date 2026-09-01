import { describe, expect, it, vi } from 'vitest'

import { getGhStatus, getGitHubStatus, type GitHubCommandRunner } from './github-service'

function result(stdout = '', status = 0, stderr = '') {
  return { status, stdout, stderr }
}

describe('non-blocking GitHub status', () => {
  it('collects repository status through the async command runner', async () => {
    const run: GitHubCommandRunner = vi.fn(async (command, args) => {
      const key = `${command} ${args.slice(0, 2).join(' ')}`
      if (key === 'git remote get-url') return result('git@github.com:crewcode/app.git\n')
      if (key === 'gh pr list') return result('[{"number":7,"title":"Fix","headRefName":"fix","state":"OPEN","url":"https://github.com/crewcode/app/pull/7"}]')
      if (key === 'gh run list') return result('[{"databaseId":9,"name":"test","status":"completed","conclusion":"success","headBranch":"fix"}]')
      if (key === 'gh issue list') return result('[{"number":1},{"number":2}]')
      return result('gh version 1')
    })

    await expect(getGitHubStatus('/repo', run)).resolves.toEqual({
      owner: 'crewcode',
      repo: 'app',
      prs: [{ number: 7, title: 'Fix', state: 'OPEN', branch: 'fix', url: 'https://github.com/crewcode/app/pull/7' }],
      runs: [{ id: 9, name: 'test', status: 'completed', conclusion: 'success', branch: 'fix' }],
      issues: 2,
    })
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
