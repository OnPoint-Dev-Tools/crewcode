// Generates browser/crewcode-plugin-api.js from the TypeScript source so the
// no-build helper can never drift from src/. Run via `npm run build:browser`.
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

await build({
  entryPoints: [join(pkgRoot, 'src', 'browser-global.ts')],
  outfile: join(pkgRoot, 'browser', 'crewcode-plugin-api.js'),
  bundle: true,
  format: 'iife',
  target: 'es2019',
  legalComments: 'none',
  banner: {
    js: '// Official CrewCode plugin browser helper. GENERATED from src/ — do not edit by hand.\n// Runs inside sandboxed plugin iframes. It never exposes Electron APIs.',
  },
})

console.log('built browser/crewcode-plugin-api.js from src/browser-global.ts')
