import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const app = readFileSync(fileURLToPath(new URL('../../App.tsx', import.meta.url)), 'utf8')
const drawer = readFileSync(fileURLToPath(new URL('./WorkspacesDrawer.tsx', import.meta.url)), 'utf8')
const styles = readFileSync(fileURLToPath(new URL('../../styles/styles.css', import.meta.url)), 'utf8')
const mobileStyles = styles.slice(styles.indexOf('@media (max-width: 768px)'))
const mobileDrawerStyles = mobileStyles.slice(
  mobileStyles.indexOf('.app-region.drawer-left'),
  mobileStyles.indexOf('.main {'),
)

describe('mobile workspace drawer', () => {
  it('uses a dedicated left/right preference without changing the desktop drawer position', () => {
    expect(app).toContain("useLocalStorageJsonState<'left' | 'right'>(MOBILE_DRAWER_SIDE_STORAGE, 'left')")
    expect(app).toContain('const effectiveDrawerPosition = mobile.isMobile ? mobileDrawerSide : tweaks.drawerPosition')
    expect(app).toContain("options={mobile.isMobile ? ['left', 'right'] : ['bottom', 'left', 'right']}")
    expect(app).toContain('position={effectiveDrawerPosition}')
    expect(app).toContain("effectiveDrawerPosition === 'bottom'")
  })

  it('renders mobile sidebars as horizontal off-canvas overlays, never bottom sheets', () => {
    expect(mobileDrawerStyles).toContain('.ws-drawer.side.left {')
    expect(mobileDrawerStyles).toContain('transform: translateX(-105%);')
    expect(mobileDrawerStyles).toContain('.ws-drawer.side.right {')
    expect(mobileDrawerStyles).toContain('transform: translateX(105%);')
    expect(mobileDrawerStyles).not.toContain('transform: translateY(100%)')
    expect(mobileDrawerStyles).not.toContain('height: 70dvh')
  })

  it('provides overlay dismissal and mobile-sized drawer controls', () => {
    expect(app).toContain('mobileOverlay={mobile.isMobile}')
    expect(drawer).toContain('className="ws-drawer-backdrop"')
    expect(drawer).toContain("if (e.key === 'Escape') setOpen(false)")
    expect(drawer).toContain('if (isSide && !mobileOverlay) return')
    expect(mobileStyles).toContain('.ws-drawer.side .ws-tab { flex: 1;')
    expect(mobileStyles).toContain('.ws-drawer.side .sess-x { width: 28px;')
  })
})
