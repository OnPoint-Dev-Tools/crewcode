import { describe, expect, it } from 'vitest'

import { appendStreamChunk, chronologicalStreamSegments } from './stream-chunks'

describe('chronologicalStreamSegments', () => {
  it('splits chunks into chronological units', () => {
    const segments = chronologicalStreamSegments(['First thought. Second thought.'], '')
    expect(segments).toEqual(['First thought.', 'Second thought.'])
  })

  it('falls back to the accumulated text when no chunks exist', () => {
    expect(chronologicalStreamSegments(undefined, 'only text')).toEqual(['only text'])
  })

  it('never returns an empty list', () => {
    expect(chronologicalStreamSegments([], '')).toEqual([' '])
  })

  // The cache is keyed by chunk text; a growing tail chunk must not serve a
  // stale split from the shorter prefix it replaced.
  it('reflects a growing tail chunk instead of serving a stale split', () => {
    const first = chronologicalStreamSegments(['Reasoning about'], '')
    expect(first).toEqual(['Reasoning about'])
    const grown = chronologicalStreamSegments(['Reasoning about the problem.'], '')
    expect(grown).toEqual(['Reasoning about the problem.'])
  })

  it('produces identical output for repeated and incremental accumulation', () => {
    let chunks: string[] | undefined
    for (const delta of ['Alpha beta. ', 'Gamma delta.\n', 'Epsilon zeta.']) {
      chunks = appendStreamChunk(chunks, delta)
    }
    const streamed = chronologicalStreamSegments(chunks, '')
    // Same chunk contents, freshly built array — must segment identically.
    const rebuilt = chronologicalStreamSegments([...(chunks ?? [])], '')
    expect(rebuilt).toEqual(streamed)
    expect(streamed).toContain('Alpha beta.')
    expect(streamed).toContain('Epsilon zeta.')
  })

  it('handles a block with far more segments than the argument-spread limit', () => {
    // Guards the push(...units) -> loop change; a spread of >100k args throws.
    const huge = Array.from({ length: 40_000 }, (_, i) => `Sentence ${i}.`).join('\n')
    const segments = chronologicalStreamSegments([huge], '')
    expect(segments.length).toBeGreaterThan(30_000)
  })
})
