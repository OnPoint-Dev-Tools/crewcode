import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

describe('About CrewCode version wiring', () => {
  it('uses runtime build info everywhere instead of a hardcoded app version', () => {
    const menu = readFileSync(join(__dirname, 'AppMenu.tsx'), 'utf8')
    const dialog = readFileSync(join(__dirname, 'AboutDialog.tsx'), 'utf8')
    const settings = readFileSync(join(__dirname, '../settings/SettingsScreen.tsx'), 'utf8')
    const webClient = readFileSync(join(__dirname, '../../runtime/web-rpc-client.ts'), 'utf8')

    expect(menu).toContain("label: 'About CrewCode'")
    expect(menu).toContain('useAppBuildInfo()')
    expect(menu).not.toMatch(/appmenu-h-v[^\n]*v\d+\.\d+\.\d+/)
    expect(dialog).toContain('Version {build?.version')
    expect(dialog).toContain('Build {build?.buildHash')
    expect(settings).toContain('const build = useAppBuildInfo()')
    expect(webClient).toContain("appBuildInfo: () => rpc('app.buildInfo', {})")
  })
})
