import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const app = readFileSync(fileURLToPath(new URL('../../App.tsx', import.meta.url)), 'utf8')
const chat = readFileSync(fileURLToPath(new URL('../chat/ChatPane.tsx', import.meta.url)), 'utf8')
const editor = readFileSync(fileURLToPath(new URL('./CodeEditor.tsx', import.meta.url)), 'utf8')
const git = readFileSync(fileURLToPath(new URL('../git/GitSidebar.tsx', import.meta.url)), 'utf8')
const styles = readFileSync(fileURLToPath(new URL('../../styles/styles.css', import.meta.url)), 'utf8')
const changesStyles = readFileSync(fileURLToPath(new URL('../../styles/turn-changes.css', import.meta.url)), 'utf8')

describe('mobile Code Editor and Git review surfaces', () => {
  it('opens Git Sidebar as a closable overlay from chat and editor surfaces', () => {
    expect(app).toContain('className="mobile-git-backdrop"')
    expect(chat).toContain('className="mobile-git-backdrop"')
    expect(git).toContain('aria-label="Close Git sidebar"')
    expect(styles).toContain('.chat-pane-row > .gs,')
    expect(styles).toContain('.ed-git-row > .gs {')
  })

  it('keeps the editor canvas primary and moves the file tree off canvas on phones', () => {
    expect(editor).toContain('useState(() => !isMobile)')
    expect(editor).toContain('className="ed-mobile-tree-backdrop"')
    expect(editor).toContain('if (isMobile) setFtOpen(false)')
    expect(styles).toContain('.ed-main > .ft {')
    expect(styles).toContain('width: min(390px, calc(100vw - 24px)) !important;')
  })

  it('uses a full-screen, vertically stacked Changes by turn review on phones', () => {
    expect(changesStyles).toContain('.turn-drawer {')
    expect(changesStyles).toContain('width: 100vw !important;')
    expect(changesStyles).toContain('grid-template-rows: minmax(132px, 38dvh) minmax(0, 1fr);')
    expect(changesStyles).toContain('.turn-drawer-body.sidebar-closed .turn-drawer-diff { grid-row: 1; }')
  })
})
