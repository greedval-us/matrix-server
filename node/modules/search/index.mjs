import { MatrixSearchService } from './service.mjs'

export const searchModule = {
  id: 'search',
  register({ server, settings, loadService, rpc }) {
    const service = new MatrixSearchService(settings, { requireSharedKey: false })
    server.addService(loadService('base_search.proto', 'base_search.BaseSearches'), {
      streamSearch: rpc.stream('search', 'StreamSearch', call => service.streamSearch(call)),
      getIndexStatus: rpc.unary('search', 'GetIndexStatus', (_request, call) => new Promise((resolve, reject) => {
        service.getIndexStatus(call, (error, result) => error ? reject(error) : resolve(result))
      })),
    })
  },
}
