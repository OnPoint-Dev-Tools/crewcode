import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const menus = readFileSync(fileURLToPath(new URL('./MobileComposerMenus.tsx', import.meta.url)), 'utf8')
const composer = readFileSync(fileURLToPath(new URL('./Composer.tsx', import.meta.url)), 'utf8')
const picker = readFileSync(fileURLToPath(new URL('./PickerSheet.tsx', import.meta.url)), 'utf8')
const styles = readFileSync(fileURLToPath(new URL('../../styles/styles.css', import.meta.url)), 'utf8')

describe('mobile composer menus', () => {
  it('shows the chosen model on one navigable settings button', () => {
    expect(menus).toContain('className="mobile-composer-model-button"')
    expect(menus).toContain("selectedModel?.label ?? shortModel(model)")
    for (const page of ["'provider'", "'model'", "'effort'", "'mode'", "'mcp'"]) {
      expect(menus).toContain(page)
    }
    expect(menus).toContain("header={header}")
    expect(menus).toContain('closeOnPick={false}')
  })

  it('consolidates files, prompts, and branch controls under Actions', () => {
    expect(menus).toContain('className="mobile-composer-action-button"')
    expect(menus).toContain("label: 'Attach files'")
    expect(menus).toContain("label: 'Prompts & Skills'")
    expect(menus).toContain("label: 'Branch'")
    expect(menus).toContain("label: 'Create branch…'")
    expect(composer).toContain('onAttach={() => fileInputRef.current?.click()}')
  })

  it('keeps desktop controls and enables non-closing picker navigation', () => {
    expect(composer).toContain('className="desktop-composer-actions"')
    expect(styles).toContain('.desktop-composer-actions { display: flex;')
    expect(styles).toContain('.mobile-composer-actions { display: none; }')
    expect(styles).toContain('background-color: transparent !important;')
    expect(styles).toContain('-webkit-appearance: none;')
    expect(styles).toContain('box-shadow: none !important;')
    expect(picker).toContain('closeOnPick = !multiSelect')
    expect(picker).toContain('if (closeOnPick) onClose()')
  })
})
