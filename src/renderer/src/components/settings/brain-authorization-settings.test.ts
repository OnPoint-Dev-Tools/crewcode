import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

describe('Brain authorization settings placement', () => {
  it('mounts Brain authorization in web Settings rather than a floating overlay', () => {
    const settings = readFileSync(join(__dirname, 'SettingsScreen.tsx'), 'utf8')
    const section = readFileSync(join(__dirname, 'BrainAuthorizationSection.tsx'), 'utf8')
    const connection = readFileSync(join(__dirname, '../../runtime/WebConnectionScreen.tsx'), 'utf8')

    expect(settings).toContain("id: 'brain-authorization', label: 'Brain Access'")
    expect(settings).toContain('{webRuntime && <BrainAuthorizationSection />}')
    expect(section).toContain('id="brain-authorization" className="ss-section"')
    expect(connection).not.toContain('<BrainAuthorizationPanel')
    expect(section).not.toContain("position: 'fixed'")
  })
})
