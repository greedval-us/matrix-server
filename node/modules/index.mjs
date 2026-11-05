import { searchModule } from './search/index.mjs'
import { catalogModule } from './catalog/index.mjs'
import { workspaceModule } from './workspace/index.mjs'
import { recordsModule } from './records/index.mjs'

// Add a feature module here; config validation and bootstrap share this registry.
export const modules = Object.freeze([searchModule, catalogModule, workspaceModule, recordsModule])
