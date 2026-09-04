import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

describe('Desktop & Web continuity settings placement', () => {
  it('exposes Background Brain only on desktop Settings, with Stop Brain withdrawing availability', () => {
    const settings = readFileSync(join(__dirname, 'SettingsScreen.tsx'), 'utf8')
    const menu = readFileSync(join(__dirname, '../ui/AppMenu.tsx'), 'utf8')

    expect(settings).toContain("id: 'brain-continuity', label: 'Desktop & Web'")
    expect(settings).toContain('{!webRuntime && <BrainContinuitySection />}')
    expect(settings).toContain('id="brain-continuity" className="ss-section"')
    expect(settings).toContain('brainDesktopStatus(true)')
    expect(settings).toContain('Hub browser · {status.hubBrowserOrigin}')
    expect(settings).toContain('The Hub web server is separate from the Brain')
    expect(settings).toContain('Open Hub')
    expect(settings).toContain('openExternal(status.hubBrowserOrigin)')
    expect(settings).toContain("id: 'hub-machines', label: 'Hub Machines'")
    expect(settings).toContain('{hubControl && <HubMachinesSection />}')
    expect(settings).toContain('client.hubMachinesList()')
    expect(settings).toContain('client.hubMachineSetEnabled(machine.id, enabled)')
    expect(settings).toContain('Its Hub relay and connected browser sessions will be disconnected')
    expect(settings).toContain('Stop Brain')
    expect(menu).toContain("label: 'Quit and stop Brain'")
    expect(menu).toContain("it.id !== 'quit-stop-brain' || isBrain")
  })
})
