import { describe, expect, it } from 'vitest'

import { NEW_TAB_ACTIONS } from './WindowTabs'

describe('WindowTabs new-tab menu', () => {
  it('offers the built-in control, studio, and Git workspace pages', () => {
    expect(NEW_TAB_ACTIONS).toEqual(expect.arrayContaining([
      { kind: 'mission', icon: 'grid', label: 'Control Center (Mission Control)' },
      { kind: 'prompts', icon: 'inspection', label: 'Skills & Prompts Studio' },
      { kind: 'git', icon: 'gitBranch', label: 'Git Workspace' },
    ]))
  })

  it('does not contain duplicate built-in destinations', () => {
    const kinds = NEW_TAB_ACTIONS.map(item => item.kind)
    expect(new Set(kinds).size).toBe(kinds.length)
  })
})
