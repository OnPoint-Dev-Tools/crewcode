import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const chatViewPath = fileURLToPath(new URL('./SoloChatView.tsx', import.meta.url))
const stylesPath = fileURLToPath(new URL('../../styles/styles.css', import.meta.url))

describe('stream render isolation contract', () => {
  it('keeps transcript auto-follow out of synchronous layout effects', () => {
    const source = readFileSync(chatViewPath, 'utf8')
    expect(source).not.toContain('useLayoutEffect')
    expect(source).toContain('requestAnimationFrame(() => {')
  })

  it('contains transcript layout and paint from workspace chrome', () => {
    const css = readFileSync(stylesPath, 'utf8')
    const threadShellRule = css.match(/\.thread-shell\s*\{[^}]*\}/)?.[0] ?? ''
    expect(threadShellRule).toContain('contain: layout paint')
  })
})
