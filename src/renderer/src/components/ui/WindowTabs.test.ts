import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

import { NEW_TAB_ACTIONS } from './WindowTabs'

describe('WindowTabs new-tab menu', () => {
  it('keeps desktop tabs and uses an on-demand sheet on mobile', () => {
    const app = readFileSync(join(__dirname, '../../App.tsx'), 'utf8')
    const styles = readFileSync(join(__dirname, '../../styles/styles.css'), 'utf8')
    expect(app).toContain('!mobile.isMobile && <div className="window-tabs">')
    expect(app).toContain('<MobileWindowTabs')
    expect(app).not.toContain('useMobileWindowTabsAutoHide')
    expect(app).toContain("setActiveTabId(id); mobile.closeSheet('tabs')")
    expect(styles).toContain('.window-tabs { display: contents; }')
    expect(styles).toContain('.window-tabs { display: none; }')
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
