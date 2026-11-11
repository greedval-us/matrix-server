# Server layer responsibilities

`application.mjs` assembles infrastructure, authorization, audit and registered
modules. `core/rpc.mjs` is the gRPC boundary: it authorizes each request and maps
application failures to public responses. Unexpected failures use generic messages;
dependency details do not become public responses. Existing access-key attribution
remains part of that boundary.

`modules/search/search.mjs` owns query construction, index status, source metadata,
suggestions and concurrency limits. It takes a request and an optional AbortSignal
and yields results through an async iterator. It does not write to a gRPC call or
perform authorization. Iteration completion, failure or early return releases the
capacity reservation.

`core/streams.mjs` owns transport writes, backpressure, stream completion and
cancellation. Search, catalogue and record downloads reuse this boundary. Closing,
cancelling or failing a stream wakes pending drain waits and removes temporary
listeners. Producers receive cancellation and close their resources when iteration
ends. The legacy `MatrixSearchService` export remains a compatibility adapter.

Repositories and infrastructure own storage and dependency access. Record metadata
transactions and attachment cleanup retain their existing confirmed/uncertain-commit
rules; transport refactoring does not move transaction decisions into gRPC handlers.

Use `npm test` for server regression checks, including local gRPC/HTTP fixtures.
The Python indexer tests are separate. These tests do not replace validation against
a deployed MySQL/Manticore environment. Publication boundaries and local Git hooks
are described in [publication.md](publication.md).
