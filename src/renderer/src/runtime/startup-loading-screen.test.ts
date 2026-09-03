import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

describe('startup loading screen', () => {
  it('exists before React mounts and reports Brain attachment phases', () => {
    const html = readFileSync(join(__dirname, '../../index.html'), 'utf8')
    const main = readFileSync(join(__dirname, '../main.tsx'), 'utf8')
    const styles = readFileSync(join(__dirname, '../styles/styles.css'), 'utf8')

    expect(html).toContain('id="startup-screen" class="loading-screen"')
    expect(html).toContain('id="startup-screen-caption"')
    expect(html.indexOf('id="startup-screen"')).toBeLessThan(html.indexOf('src="/src/main.tsx"'))
    expect(main).toContain("setStartupStatus('checking background Brain')")
    expect(main).toContain("setStartupStatus('connecting to background Brain')")
    expect(main).toContain("setStartupStatus('restoring workspaces and conversations')")
    expect(styles).toContain('body { background: #0f120f;')
    expect(styles).toContain('@media (prefers-reduced-motion: reduce)')
  })
})
