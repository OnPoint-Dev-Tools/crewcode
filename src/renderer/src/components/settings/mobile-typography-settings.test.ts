import { readFileSync } from 'fs'
import { resolve } from 'path'
import { describe, expect, it } from 'vitest'

const styles = readFileSync(resolve(__dirname, '../../styles/styles.css'), 'utf8')
const settings = readFileSync(resolve(__dirname, 'SettingsScreen.tsx'), 'utf8')

describe('mobile typography settings contract', () => {
  it('keeps chat messages and the mobile composer bound to the live mono size', () => {
    expect(styles).toContain('.agent .body { font-size: var(--mono-size, 12.5px); }')
    expect(styles).toContain('font-size: max(16px, var(--mono-size, 13.5px)) !important')
    expect(settings).toContain('Chat &amp; mono size')
  })

  it('keeps the live editor size authoritative over CodeMirror injected themes', () => {
    expect(styles).toMatch(/\.ed-cm-host \.cm-editor \{[\s\S]*?font-size: var\(--editor-size, 13px\) !important;/)
  })
})
