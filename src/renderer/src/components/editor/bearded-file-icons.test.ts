import { describe, expect, it } from 'vitest'
import { beardedFileIconUrl, beardedFolderIconUrl } from './bearded-file-icons'

describe('Bearded editor file icons', () => {
  it('prefers exact filenames and compound extensions', () => {
    expect(beardedFileIconUrl('package.json')).not.toBe(beardedFileIconUrl('unknown.custom-extension'))
    expect(beardedFileIconUrl('Component.test.tsx')).not.toBe(beardedFileIconUrl('unknown.custom-extension'))
  })

  it('maps language-backed extensions missing from the VS Code extension table', () => {
    expect(beardedFileIconUrl('index.ts')).not.toBe(beardedFileIconUrl('unknown.custom-extension'))
    expect(beardedFileIconUrl('App.TSX')).toBe(beardedFileIconUrl('App.tsx'))
  })

  it('provides distinct closed and expanded folder icons', () => {
    expect(beardedFolderIconUrl(false)).toBeTruthy()
    expect(beardedFolderIconUrl(true)).toBeTruthy()
    expect(beardedFolderIconUrl(false)).not.toBe(beardedFolderIconUrl(true))
  })
})
