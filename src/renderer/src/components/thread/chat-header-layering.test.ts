import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const stylesPath = fileURLToPath(new URL('../../styles/styles.css', import.meta.url))
const styles = readFileSync(stylesPath, 'utf8')

describe('chat header action menu layering', () => {
  it('keeps the header above thread content without clipping dropdown overflow', () => {
    const headerRule = styles.match(/\.thr-h \{([\s\S]*?)\n\}/)?.[1]
    expect(headerRule).toContain('position: relative;')
    expect(headerRule).toContain('z-index: 20;')
    expect(headerRule).toContain('overflow: visible;')
  })

  it('scopes path truncation to the path instead of the whole header', () => {
    expect(styles).toContain('.thr-h .path {')
    expect(styles).not.toMatch(/\.thr-h \{[^}]*overflow:\s*hidden;/)
  })

  it('keeps the actions dropdown positioned above its header layer', () => {
    expect(styles).toContain('.thr-h .actions .act-menu-wrap { position: relative;')
    expect(styles).toMatch(/\.tab-menu \{[\s\S]*?z-index:\s*200;/)
  })
})
