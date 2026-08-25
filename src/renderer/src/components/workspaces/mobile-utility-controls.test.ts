import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const app = readFileSync(fileURLToPath(new URL('../../App.tsx', import.meta.url)), 'utf8')
const drawer = readFileSync(fileURLToPath(new URL('./WorkspacesDrawer.tsx', import.meta.url)), 'utf8')
const dock = readFileSync(fileURLToPath(new URL('./WorkspaceDock.tsx', import.meta.url)), 'utf8')
const styles = readFileSync(fileURLToPath(new URL('../../styles/styles.css', import.meta.url)), 'utf8')
const missionStyles = readFileSync(fileURLToPath(new URL('../../styles/mission-control.css', import.meta.url)), 'utf8')
const monitorStyles = readFileSync(fileURLToPath(new URL('../../styles/system-monitor.css', import.meta.url)), 'utf8')

describe('mobile utility controls', () => {
  it('hides floating utility triggers on mobile and makes their panels phone-sized', () => {
    expect(missionStyles).toMatch(/@media \(max-width: 768px\)[\s\S]*?\.menulet-trigger \{ display: none; \}/)
    expect(monitorStyles).toMatch(/@media \(max-width: 768px\)[\s\S]*?\.sysmon-trigger \{ display: none; \}/)
    expect(missionStyles).toContain('max-height: calc(100dvh - 100px - env(safe-area-inset-bottom));')
    expect(monitorStyles).toContain('max-height: calc(100dvh - 100px - env(safe-area-inset-bottom));')
  })

  it('keeps both utilities available from the mobile workspace App tab', () => {
    expect(drawer).toContain("label: 'Agent Activity'")
    expect(drawer).toContain("action: { kind: 'toggle-menulet' }")
    expect(drawer).toContain("label: 'System Monitor'")
    expect(drawer).toContain("action: { kind: 'toggle-system-monitor' }")
    expect(drawer).toContain('renderAppRows(APP_FEATURES)')
    expect(app).toContain("case 'toggle-menulet':")
    expect(app).toContain("case 'toggle-system-monitor':")
    expect(app).toContain('open={systemMonitorOpen}')
  })

  it('shows compact provider usage at the right of the mobile workspace dock', () => {
    expect(dock).toContain('<MobileProviderUsage')
    expect(dock).toContain('className="ws-dock-mobile-provider"')
    expect(styles).toContain('.ws-dock-mobile-provider { display: none; }')
    expect(styles).toMatch(/@media \(max-width: 768px\)[\s\S]*?\.ws-dock-mobile-provider \{[\s\S]*?display: inline-flex;/)
    expect(styles).toContain('.ws-dock-active { flex: 1;')
  })
})
