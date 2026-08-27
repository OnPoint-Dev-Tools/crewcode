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

  it('collapses the page to a single column below 414px and hides the inactive view', () => {
    expect(styles).toMatch(/@media \(max-width: 768px\)[\s\S]*?\.pb \{ grid-template-columns: 1fr;/)
    expect(styles).toContain('.pb[data-view="list"]   .pb-right  { display: none; }')
    expect(styles).toContain('.pb[data-view="detail"] .pb-left   { display: none; }')
  })

  it('tightens the two-pane grid for tablet widths (769–1024px)', () => {
    expect(styles).toMatch(/@media \(max-width: 1024px\)[\s\S]*?\.pb \{ grid-template-columns: 300px 1fr;/)
  })

  it('stacks the markdown source/preview split on phones and caps source height', () => {
    expect(styles).toMatch(/@media \(max-width: 768px\)[\s\S]*?\.pd-body\.md-mode-split \{ grid-template-columns: 1fr;/)
    expect(styles).toMatch(/\.pd-body\.md-mode-split \.pd-source \{ min-height: 180px; max-height: 45vh;/)
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

  it('stacks the pb-left title row on phones so the tab strip gets full width', () => {
    expect(builder).toMatch(/isMobile \? \(\s*<>\s*<div className="pb-cats-scroll">/)
    expect(builder).toMatch(/<div className="pb-cats-tools">/)
    expect(styles).toMatch(/@media \(max-width: 768px\)[\s\S]*?\.pb-title-row \{[\s\S]*?flex-direction: column;[\s\S]*?align-items: center;/)
    expect(styles).toContain('.pb-new {')
  })

  it('scrolls the category chips horizontally on phones and moves the trailing icon tools to a separate row', () => {
    expect(styles).toMatch(/\.pb-cats \{[\s\S]*?flex-direction: column;/)
    expect(styles).toMatch(/\.pb-cats-scroll \{[\s\S]*?overflow-x: auto;/)
    expect(styles).toMatch(/\.pb-cats-tools \{[\s\S]*?justify-content: flex-end;/)
    expect(styles).toMatch(/\.pb-cats-spacer \{ display: none;/)
  })

  it('keeps the pb-left header compact and centered on phones', () => {
    expect(styles).toMatch(/@media \(max-width: 768px\)[\s\S]*?\.pb-left-h \{ padding: 12px 16px 10px; gap: 8px;/)
    expect(styles).toMatch(/@media \(max-width: 768px\)[\s\S]*?\.pb-title-row \{[\s\S]*?flex-direction: column;/)
    expect(styles).toMatch(/@media \(max-width: 768px\)[\s\S]*?\.pb-new \{[\s\S]*?align-self: center;[\s\S]*?padding: 8px 18px;/)
  })

  it('renders pb-left as a floating centered card on phones', () => {
    expect(builder).toMatch(/<aside className="pb-left">[\s\S]*?<div className="pb-inner">[\s\S]*?<div className="pb-left-h">/)
    expect(styles).toMatch(/@media \(max-width: 768px\)[\s\S]*?\.pb-left \{[\s\S]*?background: var\(--background\);[\s\S]*?margin: auto;[\s\S]*?width: 85%;/)
  })

  it('shrinks the prompt cards so 4–5 fit per phone screen', () => {
    expect(styles).toContain('.pb-card {')
    expect(styles).toMatch(/@media \(max-width: 768px\)[\s\S]*?\.pb-card \{[\s\S]*?padding: 9px 12px 9px 16px;/)
    expect(styles).toMatch(/@media \(max-width: 768px\)[\s\S]*?\.pb-card-title \{[\s\S]*?font-size: 14px;/)
    expect(styles).toContain('.pb-card-desc  {\n    font-size: 12px;\n    line-height: 1.4;\n    -webkit-line-clamp: 1;\n    width: 100%;\n  }')
    expect(styles).toContain('.pb-card-foot  { gap: 6px; font-size: 10.5px; margin-top: 2px; width: 100%; }')
  })

  it('keeps the prompt list growing to fill the sidebar so cards do not stretch vertically', () => {
    expect(styles).toMatch(/@media \(max-width: 768px\)[\s\S]*?\.pb-list \{[\s\S]*?flex: 1 1 auto;[\s\S]*?min-height: 0;/)
  })

  it('also shrinks the row-layout variant on phones', () => {
    expect(styles).toContain('.pb-row   { padding: 7px 12px; gap: 8px; border-radius: 6px; }')
    expect(styles).toContain('.pb-row-title { font-size: 12px; }')
  })
})