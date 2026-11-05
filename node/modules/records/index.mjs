import { ControlRepository } from './repository.mjs'
import { ControlFileStore } from './file-store.mjs'
import { RecordsService } from './service.mjs'

export const recordsModule = {
  id: 'records',
  register({ server, settings, pool, controlRepository, fileStore, loadService, rpc }) {
    const repository = controlRepository ?? new ControlRepository(pool)
    const service = new RecordsService(repository, fileStore ?? new ControlFileStore(settings.recordsFileDirectory))
    server.addService(loadService('records.proto', 'matrix.records.v1.Records'), {
      getCapabilities: rpc.unary('records', 'GetCapabilities', () => service.capabilities()),
      listRecords: rpc.unary('records', 'ListRecords', request => repository.list(request)),
      createRecord: rpc.unary('records', 'CreateRecord', request => repository.create(request.values)),
      updateRecord: rpc.unary('records', 'UpdateRecord', request => repository.update(request.id, request.values)),
      deleteRecord: rpc.unary('records', 'DeleteRecord', request => repository.delete(request.id)),
      uploadFiles: rpc.unary('records', 'UploadFiles', (_request, call) => service.upload(call)),
      downloadFile: rpc.stream('records', 'DownloadFile', call => service.download(call)),
      removeFile: rpc.unary('records', 'RemoveFile', request => service.remove(request)),
    })
  },
}
