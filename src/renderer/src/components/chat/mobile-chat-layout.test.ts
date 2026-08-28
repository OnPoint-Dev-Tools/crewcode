import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

const styles = readFileSync(join(__dirname, '../../styles/styles.css'), 'utf8')
const composer = readFileSync(join(__dirname, '../composer/Composer.tsx'), 'utf8')
const header = readFileSync(join(__dirname, '../thread/ChatHeader.tsx'), 'utf8')

describe('mobile solo chat layout', () => {
  it('uses a compact one-line header with a top-right actions menu', () => {
    expect(styles).toMatch(/@media \(max-width: 768px\)[\s\S]*?\.thr-h \{[\s\S]*?flex-wrap: nowrap;/)
    expect(styles).toContain('.thr-h .actions .act-menu-wrap .act-label { display: none; }')
    expect(header).toContain('mobile-chat-actions-trigger')
    expect(styles).toContain('.thr-h .actions .act-menu-wrap .mobile-chat-actions-trigger {')
    expect(styles).toContain('height: 22px;')
    expect(styles).toContain('min-height: 36px;')
    expect(header).toContain("window.innerWidth < COLLAPSE_WIDTH")
  })

  it('replaces the mobile model reveal with compact model and action menus', () => {
    expect(composer).toContain('<MobileComposerActionMenu')
    expect(composer).toContain('<MobileComposerModelMenu')
    expect(styles).toMatch(/@media \(max-width: 768px\)[\s\S]*?\.model-row-reveal \{ display: none; \}/)
    expect(styles).toContain('.mobile-composer-actions { display: flex;')
    expect(styles).toContain('.desktop-composer-actions { display: none; }')
  })

  it('keeps the mobile composer full-width, compact, and prevents iOS input zoom', () => {
    expect(styles).toMatch(/@media \(max-width: 768px\)[\s\S]*?\.composer \{ width: 100%;/)
    expect(styles).toMatch(/\.composer-wrap \{ padding: 4px 6px/)
    expect(styles).toMatch(/\.composer textarea \{[^}]*font-size: 16px;/)
    expect(styles).toContain('.mobile-composer-action-button,')
    expect(styles).toContain('.mobile-composer-model-button {')
  })

  it('keeps embedded terminal and Git side panes out of the solo-chat column', () => {
    expect(styles).toContain('.main > .termcol-outer,')
    expect(styles).toContain('.chat-pane-row > .gs { display: none !important; }')
  })
})
