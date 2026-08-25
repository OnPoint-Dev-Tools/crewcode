import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const picker = readFileSync(fileURLToPath(new URL('./PickerSheet.tsx', import.meta.url)), 'utf8')
const styles = readFileSync(fileURLToPath(new URL('../../styles/styles.css', import.meta.url)), 'utf8')
const mobileStyles = styles.slice(styles.indexOf('@media (max-width: 768px)'))

describe('mobile composer picker sheets', () => {
  it('provides a dismissible mobile backdrop', () => {
    expect(picker).toContain('className="picker-sheet-backdrop"')
    expect(picker).toContain('aria-label="Close picker"')
    expect(picker).toContain('onClick={onClose}')
    expect(styles).toContain('.picker-sheet-backdrop { display: none; }')
    expect(mobileStyles).toMatch(/\.picker-sheet-backdrop \{[\s\S]*?display: block;/)
  })

  it('renders as a compact viewport-bounded bottom sheet on mobile', () => {
    expect(mobileStyles).toMatch(/\.picker-sheet \{[\s\S]*?bottom: 0 !important;/)
    expect(mobileStyles).toContain('max-height: min(54dvh, 410px) !important;')
    expect(mobileStyles).toContain('.picker-sheet.model-picker-sheet { height: min(50dvh, 350px); }')
    expect(mobileStyles).toContain('.picker-row { min-height: 40px;')
    expect(mobileStyles).toContain('.picker-search input { min-width: 0; font-size: 16px; }')
  })
})
