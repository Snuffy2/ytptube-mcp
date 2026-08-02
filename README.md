# ytptube MCP Server

A local stdio [Model Context Protocol](https://modelcontextprotocol.io/) server
that lets an MCP client inspect and, when explicitly enabled, manage a
self-hosted [ytptube](https://github.com/arabcoders/ytptube) HTTP API.

## What is this?

This server gives an AI assistant a focused interface to your ytptube instance
without putting API credentials in prompts or source control. It can inspect
downloads, history, tasks, presets, logs, and service configuration. Changes
are disabled by default and are rejected locally before the server makes a
network request.

Ask your MCP client things such as:

- "Is my ytptube instance reachable?"
- "What is downloading right now?"
- "Show the latest completed downloads."
- "Inspect this video URL before I add it."
- "What scheduled tasks are configured?"
- "List my download presets."

When you deliberately enable write access, it can also add downloads, manage
the queue and history, update tasks and presets, and generate metadata.

## Features

- **Safe by default** — `YTPTUBE_ALLOW_MUTATIONS=false` blocks every
  state-changing request before it reaches ytptube.
- **Focused API access** — inspect health, configuration, queue/history,
  archive entries, scheduled tasks, presets, and recent logs.
- **Validated inputs** — download and task URLs must use HTTP or HTTPS; write
  tools reject raw yt-dlp CLI strings.
- **Credential-aware** — authentication is optional, but the username and
  password must be configured together and sensitive API results are redacted.
- **Small deployment surface** — standard input/output transport and a
  configured ytptube HTTP API; no file browser, shell access, notifications,
  task/preset deletion, or SSE.

## Quick start

### Prerequisites

- Node.js 20 or newer.
- A reachable self-hosted ytptube HTTP API.
- An MCP-compatible client, such as Codex or Claude Desktop.

### Install and build

```sh
git clone https://github.com/Snuffy2/ytptube-mcp.git
cd ytptube-mcp
npm ci
cp .env.example .env
# Edit .env and set YTPTUBE_BASE_URL.
npm run build
```

The build produces `dist/index.js`. Re-run `npm run build` after changing the
TypeScript source.

At startup, the built server reads the `.env` file from the checkout that
contains `dist/index.js`, even when an MCP client starts it from another
directory. Explicit environment variables take precedence over `.env`.

## Configure your MCP client

Point your client at the built entry point and keep values specific to your
ytptube instance in its environment configuration:

```toml
[mcp_servers.ytptube]
command = "node"
args = ["/absolute/path/to/ytptube-mcp/dist/index.js"]

[mcp_servers.ytptube.env]
YTPTUBE_BASE_URL = "https://media.example.net/ytptube"
YTPTUBE_ALLOW_MUTATIONS = "false"
# Set these two together only when the API requires authentication.
# YTPTUBE_USERNAME = "your-user"
# YTPTUBE_PASSWORD = "your-password"
```

Replace the path and base URL with values for your checkout and API. Do not
commit actual credentials or store them in shared shell history.

### Environment variables

| Variable                                  | Required            | Description                                                                                        |
| ----------------------------------------- | ------------------- | -------------------------------------------------------------------------------------------------- |
| `YTPTUBE_BASE_URL`                        | Yes                 | Root URL of the ytptube API, including any reverse-proxy path prefix.                              |
| `YTPTUBE_USERNAME` and `YTPTUBE_PASSWORD` | Together, if needed | Optional HTTP API credentials. Providing only one is a configuration error.                        |
| `YTPTUBE_AUTH_MODE`                       | No                  | `basic` (default) sends HTTP Basic authentication; `apikey` uses the API fallback query parameter. |
| `YTPTUBE_TIMEOUT_MS`                      | No                  | Request timeout from `100` through `300000` milliseconds; defaults to `30000`.                     |
| `YTPTUBE_ALLOW_MUTATIONS`                 | No                  | Exact string `true` enables state-changing tools. Defaults to `false`.                             |

## Safety and write access

The server is read-only by default. With `YTPTUBE_ALLOW_MUTATIONS=false`, a
request such as `ytptube_add_downloads` returns `MUTATIONS_DISABLED` locally
and sends no request to ytptube. Read-only inspection tools remain available.

Set the value to the exact string `true` only for a session that must change
state, then restart the server/client so it receives the new setting. Return
it to `false` when you are done.

```dotenv
YTPTUBE_ALLOW_MUTATIONS=true
```

The gate covers download additions/retries, queue controls, history and archive
changes, task and preset changes, and metadata generation. Clearing history
does not remove media unless the request explicitly asks for it.

## Available tools

All tools are prefixed with `ytptube_`.

| Tool group            | Tools                                                                                                                     | Purpose                                                                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Health and inspection | `ping`, `get_system_configuration`, `get_ytdlp_options`, `validate_cli_options`, `inspect_url`, `list_logs`, `live_queue` | Check the API and read service, queue, log, and downloader state. URL inspection accepts a URL plus optional preset, force, and entries values. |
| Queue and history     | `list_history`, `get_history_item`, `add_downloads`, `retry_history_item`, `queue_control`, `clear_history`               | Inspect queued and completed items; add, retry, or manage them only when mutations are enabled.                                                 |
| Archive and metadata  | `list_archive`, `set_history_archive`, `generate_task_metadata`, `generate_history_nfo`                                   | Search archive records and generate or change metadata when mutations are enabled.                                                              |
| Tasks                 | `list_tasks`, `get_task`, `inspect_task_url`, `create_tasks`, `patch_task`, `update_task`                                 | Inspect scheduled work or manage it when write access is enabled. Task URL inspection is a preview only.                                        |
| Presets               | `list_presets`, `get_preset`, `create_preset`, `patch_preset`, `update_preset`                                            | Inspect or manage reusable download settings when write access is enabled.                                                                      |

### Important limits

- Task URL inspection is a preview; ytptube does not offer a scheduled-task
  "run now" endpoint.
- Global yt-dlp options are read-only through this server.
- Write tools do not accept raw yt-dlp CLI strings. The validation tool only
  parses and validates a string; it never starts a download.
- Download `extras` accepts only `ignore_conditions`, a non-empty array of
  condition names. Use `"*"` to ignore all conditions.
- Per-download authentication and settings belong in presets. Task create and
  update inputs reject arbitrary configuration and cookies.

## Development

```sh
# Install dependencies, type-check, test, and build.
./scripts/test.sh

# Run the repository quality hooks.
prek run --all-files
```

`prek` is the repository's only linter and formatter. It checks repository
files, GitHub Actions syntax, formatting, and TypeScript types.

## Troubleshooting

**The server says `YTPTUBE_BASE_URL is required`.** Set a valid HTTP or HTTPS
base URL in the MCP client environment or `.env`, including any proxy prefix.

**Authentication fails.** Confirm the URL is correct for your proxy and that
both `YTPTUBE_USERNAME` and `YTPTUBE_PASSWORD` are set. Use `basic` unless
your ytptube API/proxy specifically requires the `apikey` fallback.

**A mutation is unavailable.** Confirm it is really required, set
`YTPTUBE_ALLOW_MUTATIONS=true`, restart the MCP client/server, perform the
operation, and then disable mutations again.

**A tool returns redacted values.** This is intentional: the server protects
credentials and sensitive values when it formats API results and errors.

## Contributing

Please open an issue before starting a large change. Keep the stdio transport,
the ytptube HTTP API boundary, and the read-only default intact. Run the local
test script and `prek` before opening a pull request.

## License

This project is licensed under the [MIT License](LICENSE.md).
