import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { composerSelectedText, replaceComposerSelection } from './composer-clipboard'

const composer = readFileSync(fileURLToPath(new URL('./Composer.tsx', import.meta.url)), 'utf8')

describe('composer clipboard editing', () => {
  it('reads and replaces the captured selection', () => {
    expect(composerSelectedText('ask the crew', 4, 7)).toBe('the')
    expect(replaceComposerSelection('ask the crew', 4, 7, 'a')).toEqual({ value: 'ask a crew', caret: 5 })
  })

  it('bounds and orders browser selection offsets', () => {
    expect(composerSelectedText('crew', 99, -2)).toBe('crew')
    expect(replaceComposerSelection('crew', 99, -2, 'team')).toEqual({ value: 'team', caret: 4 })
  })

  it('routes context-menu clipboard access through the typed CrewCode client', () => {
    expect(composer).toContain('getCrewCodeClient().clipboardWriteText')
    expect(composer).toContain('getCrewCodeClient().clipboardReadText')
    expect(composer).toContain('onContextMenu={openClipboardMenu}')
    expect(composer).toContain("valueRef.current !== menu.baseline")
  })
})
