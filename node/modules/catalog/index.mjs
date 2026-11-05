import { formatDatabaseCatalog, readDatabaseCatalog } from './catalog.mjs'

export const catalogModule = {
  id: 'catalog',
  register({ server, settings, repository, loadService, rpc }) {
    const readCatalog = repository
      ? async () => formatDatabaseCatalog(await repository.catalogRows())
      : () => readDatabaseCatalog(settings.databaseCatalogPath)
    server.addService(loadService('database_all.proto', 'database_all.DatabaseAll'), {
      streamDatabaseAll: rpc.stream('catalog', 'StreamDatabaseAll', async call => {
        const { databases } = await readCatalog()
        for (const database of databases) {
          if (call.cancelled || call.destroyed) return
          if (call.write(database.list)) continue
          await new Promise(resolve => {
            const resume = () => { call.off('drain', resume); call.off('cancelled', resume); resolve() }
            call.once('drain', resume); call.once('cancelled', resume)
          })
        }
        if (!call.cancelled && !call.destroyed) call.end()
      }),
    })
  },
}
