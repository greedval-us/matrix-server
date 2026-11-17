import { sendStream } from '../../core/streams.mjs'
import { ReleaseStore } from './store.mjs'

export const releasesModule = {
  id: 'releases',
  register({ server, settings, loadService, rpc }) {
    const store = new ReleaseStore(settings.releasesDirectory)
    server.addService(loadService('releases.proto', 'matrix.releases.v1.Releases'), {
      getLatest: rpc.unary('releases', 'GetLatest', request => store.latest(request)),
      download: rpc.stream('releases', 'Download', call => sendStream(call, options => store.download(call.request, options))),
    })
  },
}
