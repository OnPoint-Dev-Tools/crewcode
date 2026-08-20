import { createCrewCodeApi } from './create-api.js'

// Entry for the no-build browser helper (bundled to browser/crewcode-plugin-api.js).
// Exposes the ready-to-use singleton plus the factory so authors can reconfigure
// (e.g. a longer timeout on slow/SSH workspaces): window.crewcode = createCrewCodeApi({ timeoutMs: 30000 }).
declare global {
  interface Window {
    crewcode: ReturnType<typeof createCrewCodeApi>
    createCrewCodeApi: typeof createCrewCodeApi
  }
}

window.createCrewCodeApi = createCrewCodeApi
window.crewcode = createCrewCodeApi()
