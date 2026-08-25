import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

import { NEW_TAB_ACTIONS } from './WindowTabs'

describe('WindowTabs new-tab menu', () => {
  it('is mounted by App for desktop and mobile layouts', () => {
    const app = readFileSync(join(__dirname, '../../App.tsx'), 'utf8')
    const styles = readFileSync(join(__dirname, '../../styles/styles.css'), 'utf8')
    expect(app).toContain("<div className={`window-tabs${windowTabsHidden ? ' mobile-tabs-hidden' : ''}`}>")
    expect(app).toContain('<WindowTabs')
    expect(styles).toContain('.window-tabs { display: contents; }')
    expect(styles).not.toContain('.desktop-window-tabs { display: none; }')
  })
  it('auto-hides the mobile tab strip while locking it open for the add menu', () => {
    const app = readFileSync(join(__dirname, '../../App.tsx'), 'utf8')
    const tabs = readFileSync(join(__dirname, './WindowTabs.tsx'), 'utf8')
    const styles = readFileSync(join(__dirname, '../../styles/styles.css'), 'utf8')
    expect(app).toContain('useMobileWindowTabsAutoHide({')
    expect(app).toContain('onNewTabMenuOpenChange={setWindowTabsMenuOpen}')
    expect(tabs).toContain('onNewTabMenuOpenChange?.(newMenuOpen)')
    expect(styles).toContain('.window-tabs.mobile-tabs-hidden {')
    expect(styles).toContain('transform: translateY(-100%);')
  })

  it('replaces the mobile bottom nav with the scrollable tab strip and add menu', () => {
    const shell = readFileSync(join(__dirname, './MobileShell.tsx'), 'utf8')
    const styles = readFileSync(join(__dirname, '../../styles/styles.css'), 'utf8')
    expect(shell).not.toContain('mobile-bottom-nav')
    expect(styles).toMatch(/@media \(max-width: 768px\)[\s\S]*?\.tab-add-wrap \.tab-menu/)
  })

  it('offers the built-in control, studio, and Git workspace pages', () => {
    expect(NEW_TAB_ACTIONS).toEqual(expect.arrayContaining([
      { kind: 'mission', icon: 'grid', label: 'Control Center' },
      { kind: 'prompts', icon: 'inspection', label: 'Skills & Prompts Studio' },
      { kind: 'git', icon: 'gitBranch', label: 'Git Workspace' },
    ]))
  })

  it('does not contain duplicate built-in destinations', () => {
    const kinds = NEW_TAB_ACTIONS.map(item => item.kind)
    expect(new Set(kinds).size).toBe(kinds.length)
  })
})
