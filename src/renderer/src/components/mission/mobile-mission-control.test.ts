import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

const styles   = readFileSync(join(__dirname, '../../styles/mission-control.css'), 'utf8')
const control  = readFileSync(join(__dirname, 'MissionControl.tsx'),    'utf8')
const ctx      = readFileSync(join(__dirname, 'MissionDataContext.tsx'),'utf8')
const comps    = readFileSync(join(__dirname, 'MCComponents.tsx'),      'utf8')
const app      = readFileSync(join(__dirname, '../../App.tsx'),         'utf8')

describe('mobile mission control layout', () => {
  it('exposes a MissionActivitySheetHost inside MissionDataProvider', () => {
    expect(ctx).toMatch(/export function MissionActivitySheetHost/)
    expect(ctx).toMatch(/ActivityFeed/)
  })

  it('wires the activity sheet into MobileShell sheets map', () => {
    expect(app).toMatch(/'mission-activity':[\s\S]{0,160}MissionActivitySheetHost/)
  })

  it('passes onOpenActivity to MissionControlHost on mobile only', () => {
    expect(app).toMatch(/onOpenActivity=\{mobile\.isMobile \?[^}]+onSheetToggle\('mission-activity'\)[^}]+:[^}]+undefined\}/)
  })

  it('renders an Activity pill in the toolbar when onOpenActivity is set', () => {
    expect(comps).toMatch(/onOpenActivity[\s\S]{0,40}mc-activity-btn/)
  })

  it('hides the inline side feed and reveals it only via the sheet on phones', () => {
    expect(control).toMatch(/\{!isMobile && \([\s\S]*?<div className="mc-side">/)
    expect(styles).toMatch(/@media \(max-width: 768px\)[\s\S]*?\.mc-side \{ display: none; \}/)
  })

  it('collapses the 6-column StatStrip to 3 columns below 768px and 2 below 480px', () => {
    expect(styles).toMatch(/@media \(max-width: 768px\)[\s\S]*?\.mc-stats \{ grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);/)
    expect(styles).toMatch(/@media \(max-width: 480px\)[\s\S]*?\.mc-stats \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/)
  })

  it('drops the agent grid floor so cards fit on a 360px viewport', () => {
    expect(styles).toMatch(/@media \(max-width: 768px\)[\s\S]*?\.mc-grid \{ grid-template-columns: repeat\(auto-fill, minmax\(min\(280px, 100%\), 1fr\)\);/)
  })

  it('reworks BlockingBanner into a two-row layout for narrow widths', () => {
    expect(styles).toMatch(/@media \(max-width: 768px\)[\s\S]*?\.mc-banner-row \{[\s\S]*?grid-template-columns: 28px minmax\(0, 1fr\);[\s\S]*?grid-template-rows: auto auto;/)
    expect(styles).toMatch(/\.mc-banner-reply \{[\s\S]*?grid-column: 1 \/ -1; grid-row: 2;/)
  })

  it('keeps touch targets at 36px or larger for actionable controls below 768px', () => {
    expect(styles).toMatch(/@media \(max-width: 768px\)[\s\S]*?\.mc-icobtn \{ width: 36px; height: 36px;/)
    expect(styles).toMatch(/\.mc-spawn \{[\s\S]*?min-height: 36px/)
    expect(styles).toMatch(/\.mc-card-actions button \{ width: 36px; height: 36px;/)
  })

  it('prevents iOS auto-zoom on the banner reply input', () => {
    expect(styles).toMatch(/\.mc-banner-reply input \{[\s\S]*?font-size: 16px;/)
  })

  it('groups the toolbar action controls into a right-aligned second row on phones', () => {
    expect(comps).toMatch(/<div className="mc-toolbar-actions">/)
    // The desktop spacer is hidden so the action row can right-align
    // independently of the filter row.
    expect(styles).toMatch(/@media \(max-width: 768px\)[\s\S]*?\.mc-toolbar > \.grow \{ display: none;/)
    expect(styles).toMatch(/\.mc-toolbar-actions \{[\s\S]*?justify-content: flex-end;[\s\S]*?flex: 1 1 100%;/)
  })
})