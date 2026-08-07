import { describe, expect, it } from 'vitest'
import { EDITOR_THEME_IDS } from '../../../../shared/editor-theme-types'
import { EDITOR_THEME_OPTIONS, editorThemeExtension } from './editor-theme-registry'

describe('editor theme registry', () => {
  it('has exactly one option for every persisted theme id', () => {
    expect([...EDITOR_THEME_OPTIONS.map(theme => theme.id)].sort()).toEqual([...EDITOR_THEME_IDS].sort())
    expect(new Set(EDITOR_THEME_OPTIONS.map(theme => theme.id)).size).toBe(EDITOR_THEME_OPTIONS.length)
  })

  it('keeps CrewCode as the extension-free default', () => {
    expect(editorThemeExtension('crewcode')).toEqual([])
    for (const theme of EDITOR_THEME_OPTIONS.slice(1)) expect(theme.extension).not.toEqual([])
  })
})
