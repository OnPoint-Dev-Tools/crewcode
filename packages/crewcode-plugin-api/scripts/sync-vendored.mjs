// Copies the canonical plugin API into every vendored copy under
// examples/plugins/** and packages/crewcode-plugin-cli/templates/plugins/**.
//
// Two vendored forms exist because plugins are authored two ways:
//   - crewcode-plugin-api.js  (no-build plugins, <script> tag)   <- esbuild bundle
//   - src/crewcode-api.ts     (bundled TS plugins, relative import) <- generated below
//
// Both are generated so a vendored copy can never drift from src/. Run via
// `npm run sync` after `npm run build`.
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const JS_HELPER = 'crewcode-plugin-api.js'
const TS_HELPER = join('src', 'crewcode-api.ts')

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = join(pkgRoot, '..', '..')

const jsSource = readFileSync(join(pkgRoot, 'browser', JS_HELPER))

// The TS vendored copy is create-api.ts plus the default singleton, so bundled
// templates can `import { crewcode } from './crewcode-api'` with no dependency.
const tsBanner =
  '// Official CrewCode plugin API. GENERATED from crewcode-plugin-api/src — do not edit by hand.\n' +
  '// Vendored so this template builds with no external dependency.\n' +
  "// If you prefer a managed dependency: npm install crewcode-plugin-api\n\n"
const tsSource =
  tsBanner +
  readFileSync(join(pkgRoot, 'src', 'create-api.ts'), 'utf8') +
  '\nexport const crewcode = createCrewCodeApi()\n'

const vendorRoots = [
  join(repoRoot, 'examples', 'plugins'),
  join(repoRoot, 'packages', 'crewcode-plugin-cli', 'templates', 'plugins'),
]

let jsUpdated = 0
let tsUpdated = 0
for (const root of vendorRoots) {
  if (!existsSync(root)) continue
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const pluginDir = join(root, entry.name)

    // Only refresh files that already exist; never create new ones.
    const jsTarget = join(pluginDir, JS_HELPER)
    if (existsSync(jsTarget)) {
      writeFileSync(jsTarget, jsSource)
      jsUpdated++
    }

    const tsTarget = join(pluginDir, TS_HELPER)
    if (existsSync(tsTarget)) {
      writeFileSync(tsTarget, tsSource)
      tsUpdated++
    }
  }
}

console.log(`synced ${JS_HELPER} to ${jsUpdated} folder(s), ${TS_HELPER} to ${tsUpdated} folder(s)`)
