import { describe, expect, it } from 'vitest'
import { buildPullRequestBody } from './PullRequestModal'

describe('pull request creation body', () => {
  it('emits only the optional structured sections the author filled out', () => {
    expect(buildPullRequestBody({
      description: 'Release the new workflow.',
      problem: '',
      whatChanged: '- Added one\n- Added two',
      whyChanged: ' Keep review local. ',
      solution: '',
    })).toBe('## Description\n\nRelease the new workflow.\n\n## What changed\n\n- Added one\n- Added two\n\n## Why it changed\n\nKeep review local.')
  })

  it('returns an empty body when every optional section is blank', () => {
    expect(buildPullRequestBody({ description: '', problem: ' ', whatChanged: '', whyChanged: '', solution: '' })).toBe('')
  })
})
