import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const stylesPath = fileURLToPath(new URL('../../styles/styles.css', import.meta.url))
const drawerPath = fileURLToPath(new URL('./WorkspacesDrawer.tsx', import.meta.url))
const styles = readFileSync(stylesPath, 'utf8')
const drawer = readFileSync(drawerPath, 'utf8')

describe('workspace sidebar metadata', () => {
  it('keeps branch and updated metadata visible in side mode', () => {
    expect(styles).not.toMatch(
      /\.ws-drawer\.side \.ws-branch,\s*\.ws-drawer\.side \.ws-updated\s*\{\s*display:\s*none/,
    )
    expect(styles).toContain('.ws-drawer.side .ws-workspace-row .ws-branch { min-width: 0; overflow: hidden; }')
    expect(styles).toContain('.ws-drawer.side .ws-workspace-row .ws-updated { min-width: 0; white-space: nowrap; }')
  })

  it('does not apply the workspace metadata grid to completed rows', () => {
    expect(styles).not.toContain('.ws-drawer.side .ws-meta {')
    expect(styles).toContain(
      '.ws-drawer.side .ws-completed-row .ws-meta { align-self: end; padding-bottom: 1px; }',
    )
  })

  it('adds the trailing hairline to every shared workspace section', () => {
    expect(drawer).toContain('className="ws-sec ws-sec-btn ws-sec-rule"')
    expect(drawer).not.toContain('rule?:')
  })
})
