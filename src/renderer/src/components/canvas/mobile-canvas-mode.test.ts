import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

const styles = readFileSync(join(__dirname, '../../styles/styles.css'), 'utf8')
const canvas = readFileSync(join(__dirname, 'CanvasMode.tsx'),         'utf8')

describe('mobile canvas mode layout', () => {
  it('renders the Add chat / Add terminal controls as buttons (a11y)', () => {
    expect(canvas).toMatch(/<button type="button" className="canvas-mode-button" onClick=\{onNewChat\}>/)
    expect(canvas).toMatch(/<button type="button" className="canvas-mode-button" onClick=\{onNewTerminal\}>/)
  })

  it('drops pane row height to 60dvh / 600px on phones so chats fit comfortably', () => {
    expect(styles).toMatch(/@media \(max-width: 768px\)[\s\S]*?\.canvas-mode-pane-grid \{[\s\S]*?grid-auto-rows: minmax\(min\(60dvh, 600px\), 1fr\);/)
  })

  it('hides the desktop inline action cluster on phones and shows a single overflow button', () => {
    expect(styles).toMatch(/@media \(max-width: 768px\)[\s\S]*?\.canvas-mode-pane-actions \{ display: none;/)
    expect(canvas).toMatch(/className="canvas-mode-pane-menu"/)
    expect(canvas).toMatch(/className="canvas-mode-pane-more"/)
  })

  it('puts the per-pane actions in a popover menu instead of an inline cluster on mobile', () => {
    expect(styles).toMatch(/\.canvas-mode-pane-menu-pop \{[\s\S]*?position: absolute;[\s\S]*?top: calc\(100% \+ 6px\);[\s\S]*?right: 0;/)
    expect(canvas).toContain('canvas-mode-pane-menu-pop')
    // Menu items must include mode prompt, logs, and close.
    expect(canvas).toMatch(/canvas-mode-pane-menu-item[\s\S]*?Mode prompt/)
    expect(canvas).toMatch(/canvas-mode-pane-menu-item[\s\S]*?Show logs|Hide logs/)
    expect(canvas).toMatch(/canvas-mode-pane-menu-item danger[\s\S]*?Close pane/)
  })

  it('toggles the per-pane menu via a single state and closes on click-outside / Escape', () => {
    expect(canvas).toMatch(/useState<string \| null>\(null\)/)
    expect(canvas).toMatch(/paneMenuId === pane\.id/)
    expect(canvas).toMatch(/onClick=\{\(\) => setPaneMenuId\(menuOpen \? null : pane\.id\)\}/)
    expect(canvas).toMatch(/'touchstart'/)
    expect(canvas).toMatch(/'Escape'/)
  })

  it('keeps the inline cluster intact on desktop (mobile CSS does not affect it)', () => {
    // The desktop path renders `.canvas-mode-pane-actions` directly, and the
    // existing CSS for the cluster should not be hidden.
    expect(canvas).toMatch(/<div className="canvas-mode-pane-actions">/)
    expect(styles).toMatch(/\.canvas-mode-pane-actions \{[\s\S]*?display: inline-flex;/)
  })

  it('grows the prompt toggle and close button to 36×20/36×36 touch targets', () => {
    expect(styles).toMatch(/@media \(max-width: 768px\)[\s\S]*?\.canvas-mode-pane-toggle-track \{ width: 36px; height: 20px;/)
    expect(styles).toMatch(/@media \(max-width: 768px\)[\s\S]*?\.canvas-mode-pane-close \{ width: 36px;/)
  })

  it('exposes a phone-only FAB with Add chat / Add terminal actions', () => {
    expect(canvas).toContain('canvas-mode-fab-wrap')
    expect(canvas).toContain('canvas-mode-fab')
    expect(canvas).toContain('canvas-mode-fab-menu')
    expect(canvas).toMatch(/canvas-mode-fab-item[\s\S]*?onClick=\{\(\) => \{ setFabOpen\(false\); onNewChat\?\.\(\) \}\}/)
    expect(canvas).toMatch(/canvas-mode-fab-item[\s\S]*?onClick=\{\(\) => \{ setFabOpen\(false\); onNewTerminal\?\.\(\) \}\}/)
  })

  it('only renders the FAB on phones with at least one open pane', () => {
    expect(canvas).toMatch(/\{isMobile && panes\.length > 0 && \(/)
  })

  it('keeps the FAB above the safe-area inset and uses primary color', () => {
    expect(styles).toMatch(/\.canvas-mode-fab-wrap \{[\s\S]*?position: fixed;[\s\S]*?bottom: calc\(12px \+ env\(safe-area-inset-bottom\)\);/)
    expect(styles).toMatch(/\.canvas-mode-fab \{[\s\S]*?width: 48px; height: 48px;/)
  })

  it('uses useMobileLayout to drive the responsive FAB and header text', () => {
    expect(canvas).toMatch(/useMobileLayout/)
    expect(canvas).toMatch(/const \{ isMobile \} = useMobileLayout/)
  })

  it('drops the capacity caption to a short form on phones', () => {
    expect(canvas).toMatch(/isMobile\s*\?\s*`\$\{openChatCount \+ openTerminalCount\} open`/)
  })

  it('trims the empty-hub start cards below 480px', () => {
    expect(styles).toMatch(/@media \(max-width: 480px\)[\s\S]*?\.canvas-mode-start-icon \{ width: 32px; height: 32px;/)
  })
})