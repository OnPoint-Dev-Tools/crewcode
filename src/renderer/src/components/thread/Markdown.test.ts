import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { normalizeCodeLanguage } from '../code/CodeBlock'
import { Markdown } from './Markdown'

describe('agent message Markdown code', () => {
  it('routes fenced code through the syntax-highlighted code block', () => {
    const html = renderToStaticMarkup(React.createElement(Markdown, { text: '```typescript\nconst answer = 42\n```' }))

    expect(html).toContain('shiki-block-fallback md-code-highlight')
    expect(html).toContain('const answer = 42')
    expect(html).not.toContain('<pre><pre')
  })

  it('keeps inline code lightweight', () => {
    const html = renderToStaticMarkup(React.createElement(Markdown, { text: 'Run `npm test` next.' }))

    expect(html).toContain('class="md-code-inline"')
    expect(html).not.toContain('shiki-block')
  })

  it('preserves semantic hooks for theme-aware Markdown highlighting', () => {
    const html = renderToStaticMarkup(React.createElement(Markdown, {
      text: '# Heading\n\n- **Bold** and *emphasis* with `inline`',
    }))

    expect(html).toContain('class="md-h1"')
    expect(html).toContain('class="md-ul"')
    expect(html).toContain('class="md-li"')
    expect(html).toContain('class="md-strong"')
    expect(html).toContain('class="md-em"')
    expect(html).toContain('class="md-code-inline"')
  })

  it.each([
    ['typescript', 'ts'],
    ['javascript', 'js'],
    ['shell', 'bash'],
    ['py', 'python'],
    ['plaintext', 'text'],
  ])('normalizes %s fences to the bundled %s grammar', (input, expected) => {
    expect(normalizeCodeLanguage(input)).toBe(expected)
  })
})
