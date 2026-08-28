import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

const styles   = readFileSync(join(__dirname, '../../styles/prompt-builder.css'), 'utf8')
const builder  = readFileSync(join(__dirname, 'PromptBuilder.tsx'),   'utf8')
const detail   = readFileSync(join(__dirname, 'PromptDetail.tsx'),    'utf8')

describe('mobile prompt builder layout', () => {
  it('exposes a list/detail navigation state driven by `useMobileLayout`', () => {
    expect(builder).toMatch(/useMobileLayout/)
    expect(builder).toMatch(/setView\('detail'\)|setView\("detail"\)/)
    expect(builder).toMatch(/setView\('list'\)|setView\("list"\)/)
    expect(builder).toMatch(/data-view=/)
  })

  it('collapses the page to a min-width-zero single column below 768px and hides the inactive view', () => {
    expect(styles).toMatch(/@media \(max-width: 768px\)[\s\S]*?\.pb \{[\s\S]*?grid-template-columns: minmax\(0, 1fr\);[\s\S]*?min-width: 0;/)
    expect(styles).toContain('.pb[data-view="list"]   .pb-right  { display: none; }')
    expect(styles).toContain('.pb[data-view="detail"] .pb-left   { display: none; }')
  })

  it('tightens the two-pane grid for tablet widths (769–1024px)', () => {
    expect(styles).toMatch(/@media \(max-width: 1024px\)[\s\S]*?\.pb \{ grid-template-columns: 300px 1fr;/)
  })

  it('removes split mode on phones and gives source the full remaining body height', () => {
    expect(detail).toMatch(/isMobile:\s+boolean/)
    expect(detail).toMatch(/visibleMdMode: MdMode = isMobile && mdMode === 'split' \? 'source' : mdMode/)
    expect(detail).toMatch(/!isMobile && \(\s*<button className=\{visibleMdMode === 'split'/)
    expect(detail).toMatch(/className=\{`pd-body md-mode-\$\{visibleMdMode\}`\}/)
    expect(styles).not.toMatch(/@media \(max-width: 768px\)[\s\S]*?\.pd-body\.md-mode-split/)
    expect(styles).toMatch(/@media \(max-width: 768px\)[\s\S]*?\.pd-source \{[\s\S]*?height: 100%;[\s\S]*?min-height: 0;/)
  })

  it('renders a Back button on the detail header when onBack is set', () => {
    expect(detail).toMatch(/onBack\?:/)
    expect(detail).toMatch(/onBack && \(/)
    expect(detail).toContain('pd-back-btn')
    expect(detail).toContain('chevLeft')
  })

  it('hides the Back button on desktop and shows it only below 768px', () => {
    expect(styles).toMatch(/\.pd-back-btn \{[\s\S]*?display: none/)
    expect(styles).toMatch(/@media \(max-width: 768px\)[\s\S]*?\.pd-back-btn \{[\s\S]*?display: inline-flex/)
  })

  it('keeps touch targets at 36px or larger for actionable controls below 768px', () => {
    expect(styles).toMatch(/@media \(max-width: 768px\)[\s\S]*?\.pb-icobtn \{ width: 36px; height: 36px;/)
    expect(styles).toMatch(/\.pd-icobtn \{ width: 36px; height: 36px;/)
    expect(styles).toMatch(/\.pd-mdt-btn \{ width: 36px; height: 36px;/)
    expect(styles).toMatch(/\.pd-save \{[\s\S]*?min-height: 36px/)
  })

  it('prevents iOS auto-zoom by setting 16px on inputs inside the page', () => {
    expect(styles).toMatch(/@media \(max-width: 768px\)[\s\S]*?\.pb-search input[\s\S]*?font-size: 16px;/)
  })

  it('hides keyboard-shortcut noise below 768px', () => {
    expect(styles).toMatch(/@media \(max-width: 768px\)[\s\S]*?\.pb-search \.kbd,[\s\S]*?\.pb-foot-kbd,/)
  })

  it('collapses the PromptPicker popover into a bottom-anchored full-bleed sheet on phones', () => {
    expect(styles).toMatch(/@media \(max-width: 768px\)[\s\S]*?\.ppicker \{[\s\S]*?top: auto; bottom: 0;[\s\S]*?border-radius: 16px 16px 0 0/)
    expect(styles).toMatch(/\.ppicker-fill \{[\s\S]*?width: 100%;[\s\S]*?border-left: 0;[\s\S]*?border-bottom: 1px solid var\(--border\)/)
  })

  it('keeps the title actions in one bounded row on phones', () => {
    expect(builder).toMatch(/<div className="pb-cats-tools">/)
    expect(styles).toMatch(/@media \(max-width: 768px\)[\s\S]*?\.pb-title-row \{[\s\S]*?min-width: 0;/)
    expect(styles).toMatch(/\.pb-tabs \{[\s\S]*?grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/)
  })

  it('omits category chips on phones and keeps only the trailing tools', () => {
    expect(builder).not.toMatch(/isMobile \? \([\s\S]*?pb-cats-scroll/)
    expect(builder).toMatch(/isMobile \? \([\s\S]*?<div className="pb-cats-tools">/)
    expect(builder).toMatch(/if \(!isMobile && category !== 'all'/)
    expect(styles).not.toMatch(/@media \(max-width: 768px\)[\s\S]*?\.pb-cats-scroll \{/)
    expect(styles).toMatch(/\.pb-cats-tools \{[\s\S]*?flex: 0 0 auto;[\s\S]*?margin-left: auto;/)
    expect(styles).toMatch(/\.pb-cats-spacer \{ display: none;/)
  })

  it('keeps the pb-left header compact on phones', () => {
    expect(styles).toMatch(/@media \(max-width: 768px\)[\s\S]*?\.pb-left-h \{ padding: 8px 10px 7px; gap: 6px;/)
    expect(styles).toMatch(/@media \(max-width: 768px\)[\s\S]*?\.pb-new \{[\s\S]*?min-height: 36px;[\s\S]*?padding: 6px 10px;/)
  })

  it('renders pb-left edge-to-edge without percentage gutters or horizontal overflow', () => {
    expect(builder).toMatch(/<aside className="pb-left">[\s\S]*?<div className="pb-inner">[\s\S]*?<div className="pb-left-h">/)
    expect(styles).toMatch(/@media \(max-width: 768px\)[\s\S]*?\.pb-left \{[\s\S]*?margin: 0;[\s\S]*?width: 100%;[\s\S]*?min-width: 0;[\s\S]*?overflow: hidden;/)
    expect(styles).not.toContain('width: 85%')
  })

  it('shrinks the prompt cards so 4–5 fit per phone screen', () => {
    expect(styles).toContain('.pb-card {')
    expect(styles).toMatch(/@media \(max-width: 768px\)[\s\S]*?\.pb-card \{[\s\S]*?flex: 0 0 auto;[\s\S]*?max-width: 100%;[\s\S]*?height: auto;[\s\S]*?overflow: hidden;[\s\S]*?padding: 8px 10px 8px 13px;/)
    expect(styles).toMatch(/@media \(max-width: 768px\)[\s\S]*?\.pb-card-title \{[\s\S]*?font-size: 13px;/)
    expect(styles).toMatch(/\.pb-card-title \{[\s\S]*?white-space: normal;[\s\S]*?overflow: hidden;[\s\S]*?flex: 0 0 auto;/)
    expect(styles).toMatch(/\.pb-card-desc  \{[\s\S]*?font-size: 11px;[\s\S]*?display: block;[\s\S]*?overflow: hidden;[\s\S]*?-webkit-line-clamp: unset;[\s\S]*?height: auto;[\s\S]*?flex: 0 0 auto;/)
    expect(styles).toMatch(/\.pb-card-foot  \{[\s\S]*?font-size: 9.5px;/)
  })

  it('keeps the prompt list growing to fill the sidebar so cards do not stretch vertically', () => {
    expect(styles).toMatch(/@media \(max-width: 768px\)[\s\S]*?\.pb-list \{[\s\S]*?flex: 1 1 auto;[\s\S]*?min-height: 0;/)
  })

  it('also shrinks the row-layout variant on phones', () => {
    expect(styles).toContain('.pb-row   { padding: 7px 12px; gap: 8px; border-radius: 6px; }')
    expect(styles).toContain('.pb-row-title { font-size: 12px; }')
  })
})
