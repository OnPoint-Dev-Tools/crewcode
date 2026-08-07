export * from './create-api'

import { createCrewCodeApi } from './create-api'

// Default singleton for `import { crewcode } from 'crewcode-plugin-api'`.
// Authors who need custom options can call createCrewCodeApi() themselves.
export const crewcode = createCrewCodeApi()
