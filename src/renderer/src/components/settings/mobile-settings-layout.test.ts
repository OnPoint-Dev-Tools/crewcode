import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const settingsStyles = readFileSync(fileURLToPath(new URL('../../styles/settings.css', import.meta.url)), 'utf8')
const appStyles = readFileSync(fileURLToPath(new URL('../../styles/styles.css', import.meta.url)), 'utf8')
const drawer = readFileSync(fileURLToPath(new URL('../workspaces/WorkspacesDrawer.tsx', import.meta.url)), 'utf8')
const mobileSettings = settingsStyles.slice(settingsStyles.indexOf('/* ---------- Mobile settings ---------- */'))
const mobileApp = appStyles.slice(appStyles.indexOf('@media (max-width: 768px)'))

describe('mobile Settings layout', () => {
  it('removes the mobile titlebar while retaining the tab strip', () => {
    expect(mobileApp).toContain('.titlebar { display: none; }')
    expect(mobileApp).toContain('.wintabs {')
    expect(mobileApp).not.toContain('.wintabs { display: none; }')
    expect(mobileApp).toContain('top: 40px;')
  })

  it('turns Settings into a stacked layout with horizontally scrollable categories', () => {
    expect(mobileSettings).toContain('.settings-shell {')
    expect(mobileSettings).toContain('flex-direction: column;')
    expect(mobileSettings).toContain('.ss-nav-list {')
    expect(mobileSettings).toContain('overflow-x: auto;')
    expect(mobileSettings).toContain('.ss-detail { flex: 1; min-height: 0; min-width: 0; }')
  })

  it('stacks setting rows and gives controls phone-safe widths and input sizing', () => {
    expect(mobileSettings).toMatch(/\.ss-row,[\s\S]*?grid-template-columns: minmax\(0, 1fr\);/)
    expect(mobileSettings).toContain('.ss-slider { width: 100%; max-width: 100%; }')
    expect(mobileSettings).toContain('.ss-select { width: 100%; min-width: 0; min-height: 38px; }')
    expect(mobileSettings).toContain('.ss-toggle[role="switch"] {')
    expect(mobileSettings).toContain('flex: 0 0 42px;')
    expect(mobileSettings).toContain('height: 24px;')
    expect(mobileSettings).toContain('.ss-toggle[role="switch"].on::after { transform: translateX(18px); }')
    expect(mobileSettings).toContain('.settings-shell textarea { font-size: 16px; }')
  })

  it('moves former titlebar destinations into the workspace drawer App tab', () => {
    for (const entry of [
      "label: 'Settings'",
      "label: 'Archive'",
      "label: 'Docs'",
      "label: 'Check for updates'",
    ]) expect(drawer).toContain(entry)
    expect(drawer).toContain("action: { kind: 'open-tab', tab: 'settings' }")
    expect(drawer).toContain("action: { kind: 'open-tab', tab: 'archive' }")
    expect(drawer).toContain("action: { kind: 'docs' }")
    expect(drawer).toContain("action: { kind: 'updates' }")
  })
})
