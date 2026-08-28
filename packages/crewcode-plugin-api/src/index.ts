export * from './create-api.js'

import { createCrewCodeApi } from './create-api.js'

// Default singleton for `import { crewcode } from 'crewcode-plugin-api'`.
// Authors who need custom options can call createCrewCodeApi() themselves.
export const crewcode = createCrewCodeApi()
