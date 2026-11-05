export const workspaceModule = {
  id: 'workspace',
  register({ server, repository, loadService, rpc }) {
    const unary = (method, action) => rpc.unary('workspace', method, action, 'admin')
    server.addService(loadService('workspace.proto', 'matrix.workspace.v1.Workspace'), {
      listRows: unary('ListRows', request => repository.list(request.resource, { limit: request.limit || 100, offset: request.offset })),
      getRow: unary('GetRow', request => repository.get(request.resource, request.id)),
      createRow: unary('CreateRow', request => repository.create(request.resource, request.values)),
      updateRow: unary('UpdateRow', request => repository.update(request.resource, request.id, request.values)),
      deleteRow: unary('DeleteRow', request => repository.delete(request.resource, request.id)),
    })
  },
}
