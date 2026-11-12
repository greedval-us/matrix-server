import { sendStream } from '../../core/streams.mjs'
import { SearchService } from './search.mjs'

export const searchModule = {
  id: 'search',
  register({ server, settings, repository, loadService, rpc }) {
    const readSourceMetadata = repository?.searchSourceMetadata?.bind(repository)
    const readFieldLabels = repository?.searchFieldLabels?.bind(repository)
    const service = new SearchService(settings, { readSourceMetadata, readFieldLabels })
    server.addService(loadService('base_search.proto', 'base_search.BaseSearches'), {
      streamSearch: rpc.stream('search', 'StreamSearch', call => sendStream(call, options => service.search(call.request, options))),
      getIndexStatus: rpc.unary('search', 'GetIndexStatus', () => service.indexStatus()),
    })
  },
}
