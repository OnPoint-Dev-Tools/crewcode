#!/usr/bin/env node
// node-pty 1.1.0's npm tarball ships the macOS spawn-helper files without the
// executable bit. Its native addon invokes this helper through posix_spawnp, so
// terminals fail with the otherwise opaque "posix_spawnp failed" error until
// the mode is restored. Keep this local workaround until node-pty ships the
// helpers as executables.
import { chmodSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

if (process.platform !== 'win32') {
  const nodePtyRoot = join(process.cwd(), 'node_modules', 'node-pty')
  const candidates = [join(nodePtyRoot, 'build', 'Release', 'spawn-helper')]
  const prebuilds = join(nodePtyRoot, 'prebuilds')

  if (existsSync(prebuilds)) {
    for (const directory of readdirSync(prebuilds)) {
      if (directory.startsWith('darwin-')) candidates.push(join(prebuilds, directory, 'spawn-helper'))
    }
  }

  for (const helper of candidates) {
    if (existsSync(helper)) chmodSync(helper, 0o755)
  }
}
