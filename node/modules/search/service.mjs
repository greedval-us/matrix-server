import { createAuthorizer } from '../../core/auth.mjs'
import { createRpcHandlers } from '../../core/rpc.mjs'
import { sendStream } from '../../core/streams.mjs'
import { SearchService } from './search.mjs'

export { SearchCapacity } from './search.mjs'

// Compatibility adapter for consumers of node/service.mjs. The application
// registers SearchService directly behind its shared authorization/audit layer.
export class MatrixSearchService extends SearchService {
  constructor(settings, { requireSharedKey = true, ...dependencies } = {}) {
    super(settings, dependencies)
    this.authorize = requireSharedKey
      ? createAuthorizer({ ...settings, authMode: 'shared' })
      : async () => {}
    const rpc = createRpcHandlers({ authorize: this.authorize, audit: { record() {} } })
    this.streamSearch = rpc.stream('search', 'StreamSearch', call =>
      sendStream(call, options => this.search(call.request, options)))
    this.getIndexStatus = rpc.unary('search', 'GetIndexStatus', () => this.indexStatus())
    this.streamDatabaseAll = rpc.stream('catalog', 'StreamDatabaseAll', call =>
      sendStream(call, async function* () {
        const catalog = await this.readCatalog(settings.databaseCatalogPath)
        for (const database of catalog.databases) yield database.list
      }.bind(this)))
  }
}
