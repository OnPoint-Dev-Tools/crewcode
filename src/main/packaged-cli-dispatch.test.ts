import { describe, expect, it } from 'vitest'
import { packagedHeadlessArgs } from './packaged-cli-dispatch'

describe('packaged CrewCode CLI dispatch', () => {
  it('keeps bare and unrelated invocations in the desktop app', () => {
    expect(packagedHeadlessArgs(['/opt/CrewCode/crewcode'])).toBeNull()
    expect(packagedHeadlessArgs(['/opt/CrewCode/crewcode', '--help'])).toBeNull()
    expect(packagedHeadlessArgs(['/opt/CrewCode/crewcode', 'unknown'])).toBeNull()
  })

  it('routes supported headless commands with all arguments intact', () => {
    expect(packagedHeadlessArgs(['/tmp/.mount/crewcode', 'hub', 'mobile', '--tailscale', '--data-dir', '/state']))
      .toEqual(['hub', 'mobile', '--tailscale', '--data-dir', '/state'])
    expect(packagedHeadlessArgs(['/tmp/.mount/crewcode', 'brain', '--data-dir', '/brain']))
      .toEqual(['brain', '--data-dir', '/brain'])
    expect(packagedHeadlessArgs(['/tmp/.mount/crewcode', 'enroll', '--hub', 'https://hub.example']))
      .toEqual(['enroll', '--hub', 'https://hub.example'])
    expect(packagedHeadlessArgs(['/tmp/.mount/crewcode', 'serve'])).toEqual(['serve'])
  })
})
