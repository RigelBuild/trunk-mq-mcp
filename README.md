# Trunk Merge Queue MCP

A read-only MCP server for inspecting Trunk merge queues through three tools:

- `get_queue` — current queue state for a repository and target branch.
- `get_pr_status` — submitted pull request status, checks, and failure reason.
- `get_batch` — the trial batch in which a submitted pull request was tested.

**The source contains no Trunk write endpoints.** Read-only is a property of
the code rather than of registration or of the credential, which Trunk cannot
scope down — so the service cannot enqueue, cancel, or modify queue work even
though its token could. A test asserts their absence and that the client
exposes exactly its three read methods.

## HTTP entrypoint

The server accepts MCP Streamable HTTP requests at `POST /mcp`. Launch it
locally with:

```sh
TRUNK_MQ_TRUNK_TOKEN=... TRUNK_MQ_GITHUB_TOKEN=... bun run server
```

`TRUNK_MQ_TRUNK_TOKEN` and `TRUNK_MQ_GITHUB_TOKEN` are required. Set
`TRUNK_MQ_HOST` to override the default host (`127.0.0.1`) and
`TRUNK_MQ_PORT` to override the default port (`4005`).

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
