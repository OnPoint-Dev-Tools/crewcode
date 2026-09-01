import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

describe('remote-access package scripts', () => {
  it('exposes enrollment, manual Brain, and Tailscale mobile Hub commands', () => {
    const packageJson = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8')) as {
      scripts?: Record<string, string>
    }

    expect(packageJson.scripts?.enroll).toBe('npm run build && node bin/crewcode-server.mjs enroll')
    expect(packageJson.scripts?.brain).toBe('npm run build && node bin/crewcode-server.mjs brain')
    expect(packageJson.scripts?.['hub:mobile']).toBe('npm run build && node bin/crewcode-server.mjs hub mobile --tailscale')
    expect(packageJson.scripts?.['hub:mobile']).not.toContain('--tailscale-replace')
  })
})
