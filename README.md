# Trunk Merge Queue MCP

A read-only MCP server for inspecting Trunk merge queues: queue state, a
submitted pull request's status and failure reason, and the batch a PR was
tested in.

**The source contains no Trunk write endpoints.** Read-only is a property of
the code rather than of registration or of the credential, which Trunk cannot
scope down — so the service cannot enqueue, cancel, or modify queue work even
though its token could. A test asserts their absence and that the client
exposes exactly its three read methods.

Currently implemented: the typed Trunk API client. The MCP tool surface and
the HTTP entrypoint are not built yet.

## Development

Bun 1.4.0 or newer.

```sh
bun install
bun test
bun run typecheck
bun run lint
```

Tests run against response fixtures captured from the live API; no network
access or token is needed.

## License

MIT
