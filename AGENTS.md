# ytptube-mcp agent notes

- Keep the protocol transport on stdio and the backend boundary at the configured ytptube HTTP API.
- `YTPTUBE_ALLOW_MUTATIONS` must default to `false`; state-changing requests must be rejected before any network request unless its value is exactly `true`.
- `YTPTUBE_BASE_URL` is required. Authentication is optional, but username and password must be configured together. Do not place real credentials in committed files, tests, logs, or documentation.
- Keep global configuration read-only. Do not add file browsing/streaming, terminal/system administration, notifications, task/preset deletion, or SSE without an explicit product decision and matching safety review.
- Before changing the public tool contract, update README examples and exercise a read-only path plus a rejected-mutation path.
