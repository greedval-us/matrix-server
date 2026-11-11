import { formatDatabaseCatalog, readDatabaseCatalog } from './catalog.mjs'
import { sendStream } from '../../core/streams.mjs'

export const catalogModule = {
  id: 'catalog',
  register({ server, settings, repository, loadService, rpc }) {
    const readCatalog = repository
      ? async () => formatDatabaseCatalog(await repository.catalogRows())
      : () => readDatabaseCatalog(settings.databaseCatalogPath)
    server.addService(loadService('database_all.proto', 'database_all.DatabaseAll'), {
      streamDatabaseAll: rpc.stream('catalog', 'StreamDatabaseAll', call => sendStream(call, async function* () {
        const { databases } = await readCatalog()
        for (const database of databases) yield database.list
      })),
    })
  },
}
