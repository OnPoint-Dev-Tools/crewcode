import { describe, expect, it } from 'vitest'
import { canPasteInto, parentRel, pasteTargetDirRel } from './file-tree-clipboard'

describe('file tree clipboard', () => {
  it('pastes into the folder under the cursor, or a file parent, or the root', () => {
    expect(pasteTargetDirRel(null, true)).toBe('')
    expect(pasteTargetDirRel({ rel: 'src', kind: 'dir' }, true)).toBe('src')
    expect(pasteTargetDirRel({ rel: 'src/index.ts', kind: 'file' }, false)).toBe('src')
    expect(pasteTargetDirRel({ rel: 'index.ts', kind: 'file' }, false)).toBe('')
  })

  it('refuses pasting a folder into itself or a descendant', () => {
    expect(canPasteInto({ rel: 'src/lib', kind: 'dir', mode: 'copy' }, 'src/lib')).toBe(false)
    expect(canPasteInto({ rel: 'src/lib', kind: 'dir', mode: 'copy' }, 'src/lib/nested')).toBe(false)
    expect(canPasteInto({ rel: 'src/lib', kind: 'dir', mode: 'copy' }, 'src')).toBe(true)
    expect(canPasteInto({ rel: 'src/lib', kind: 'dir', mode: 'copy' }, '')).toBe(true)
    expect(canPasteInto({ rel: 'src/index.ts', kind: 'file', mode: 'copy' }, 'src')).toBe(true)
    expect(canPasteInto({ rel: '', kind: 'dir', mode: 'copy' }, 'src')).toBe(false)
  })

  it('lets copy paste into the same folder, but cut must move elsewhere', () => {
    expect(canPasteInto({ rel: 'src/index.ts', kind: 'file', mode: 'copy' }, 'src')).toBe(true)
    expect(canPasteInto({ rel: 'src/index.ts', kind: 'file', mode: 'cut' }, 'src')).toBe(false)
    expect(canPasteInto({ rel: 'src/index.ts', kind: 'file', mode: 'cut' }, '')).toBe(true)
    expect(canPasteInto({ rel: 'index.ts', kind: 'file', mode: 'cut' }, '')).toBe(false)
  })

  it('derives parent rels with workspace-relative slashes', () => {
    expect(parentRel('src/index.ts')).toBe('src')
    expect(parentRel('index.ts')).toBe('')
  })
})
