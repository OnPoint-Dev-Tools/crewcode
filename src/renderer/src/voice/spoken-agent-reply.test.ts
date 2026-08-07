import { describe, expect, it } from 'vitest'

import { naturalSpokenReply, spokenAgentMessage } from './spoken-agent-reply'

describe('naturalSpokenReply', () => {
  it('keeps outcome prose while removing syntax-heavy content', () => {
    const reply = naturalSpokenReply([
      'Implemented the voice controller.',
      '```ts',
      'const secret = await createSecret()',
      '```',
      '| Provider | Status |',
      '| --- | --- |',
      'See [the docs](https://example.com/very/long/path) for details.',
      'Tests pass.',
    ].join('\n'))

    expect(reply).toBe('Implemented the voice controller. See the docs for details. Tests pass.')
    expect(reply).not.toContain('const')
    expect(reply).not.toContain('https://')
    expect(reply).not.toContain('|')
  })

  it('keeps the complete prose response without sentence or character truncation', () => {
    const longSentence = `Details ${'remain audible '.repeat(60).trim()}.`
    expect(naturalSpokenReply(`One. Two. Three. Four. ${longSentence}`)).toBe(
      `One. Two. Three. Four. ${longSentence}`,
    )
  })

  it('uses a natural fallback when a reply contains only code', () => {
    expect(naturalSpokenReply('```ts\nconst answer = 42\n```')).toBe(
      'The coding agent finished. The full technical result is available in the chat.',
    )
  })
})

describe('spokenAgentMessage', () => {
  it('speaks text blocks and never code blocks', () => {
    const spoken = spokenAgentMessage({
      kind: 'agent',
      time: 'now',
      blocks: [
        ['t', 'The fix is complete.'],
        ['c', 'dangerouslyReadableCode()'],
        ['t', 'All tests pass.'],
      ],
    })

    expect(spoken).toBe('The fix is complete. All tests pass.')
    expect(spoken).not.toContain('dangerouslyReadableCode')
  })
})
