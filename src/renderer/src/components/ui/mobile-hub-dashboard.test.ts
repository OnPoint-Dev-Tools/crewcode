import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

const dashboard = readFileSync(join(__dirname, 'MobileDashboard.tsx'), 'utf8')
const connection = readFileSync(join(__dirname, '../../runtime/WebConnectionScreen.tsx'), 'utf8')
const hubServer = readFileSync(join(__dirname, '../../../../main/hub-server.ts'), 'utf8')

describe('Hub mobile dashboard home', () => {
  it('uses live Hub machine data instead of the original mock content', () => {
    expect(dashboard).toContain('machines: MobileHubMachine[]')
    expect(dashboard).toContain("machine.status === 'online'")
    expect(dashboard).not.toContain('value={12}')
    expect(dashboard).not.toContain('crewcode-dashboard')
    expect(dashboard).not.toContain('feat/agent-orchestration')
  })

  it('mounts only for the explicit Hub home route at the shared mobile breakpoint', () => {
    expect(connection).toContain("get('hub') === 'mobile'")
    expect(connection).toContain('useMobileLayout()')
    expect(connection).toContain("machineId ? <HubMobileMachineOverview machineId={machineId} /> : <HubMobileHome />")
    expect(connection).toContain("loadHubMobileMachines(): Promise<MobileHubMachine[]>")
    expect(connection).toContain("hubMobileJson<{ machines?: MobileHubMachine[] }>('/api/v1/hub/machines')")
  })

  it('uses the supplied theme-aware CrewCode logo instead of a bolt mark', () => {
    const brand = readFileSync(join(__dirname, 'MobileBrand.tsx'), 'utf8')
    expect(brand).toContain("icon-logo-dark.png")
    expect(brand).toContain("icon-logo-light.png")
    expect(dashboard).toContain('<MobileBrand isDark={isDark} />')
    expect(dashboard).not.toContain('<Zap')
  })

  it('redirects authenticated mobile Hub visits while preserving an admin escape hatch', () => {
    expect(hubServer).toContain("window.matchMedia('(max-width: 768px)').matches")
    expect(hubServer).toContain("location.replace('/app?hub=mobile')")
    expect(hubServer).toContain("has('hub-admin')")
    expect(connection).toContain("window.location.assign('/?hub-admin=1')")
  })
})
