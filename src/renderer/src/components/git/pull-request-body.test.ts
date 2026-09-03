import { describe, expect, it } from 'vitest'
import { parsePullRequestBodySections } from './pull-request-body'

describe('pull request body sections', () => {
  it('preserves authored headings and introductory text', () => {
    expect(parsePullRequestBodySections('Context first.\n\n## Problem\nStartup is slow.\n\n## Solution\nCache the result.')).toEqual([
      { title: 'Description', body: 'Context first.', provided: true },
      { title: 'Problem', body: 'Startup is slow.', provided: true },
      { title: 'What changed', body: '', provided: false },
      { title: 'Why it changed', body: '', provided: false },
      { title: 'Solution', body: 'Cache the result.', provided: true },
    ])
  })

  it('does not invent problem or solution sections', () => {
    const sections = parsePullRequestBodySections('A short PR description.')
    expect(sections[0]).toEqual({ title: 'Description', body: 'A short PR description.', provided: true })
    expect(sections.slice(1)).toEqual([
      { title: 'Problem', body: '', provided: false },
      { title: 'What changed', body: '', provided: false },
      { title: 'Why it changed', body: '', provided: false },
      { title: 'Solution', body: '', provided: false },
    ])
    expect(parsePullRequestBodySections('  ')).toHaveLength(5)
  })
})
