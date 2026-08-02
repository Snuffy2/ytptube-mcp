# ytptube MCP server

`ytptube-mcp` is a local stdio [Model Context Protocol](https://modelcontextprotocol.io/) server for a self-hosted ytptube HTTP API. It lets an MCP client inspect and operate that API without exposing its credentials in prompts or source control.

It is a Node.js TypeScript project; it is not published to npm. Run it from a checked-out copy of this repository.

## Features

| Tool group | Tools (each starts with `ytptube_`) | What it is for |
| --- | --- |
| Health and inspection | `ping`, `get_system_configuration`, `get_ytdlp_options`, `validate_cli_options`, `inspect_url`, `list_logs`, `live_queue` | Check API health and read service, queue, and downloader state. |
| Queue and history | `list_history`, `get_history_item`, `add_downloads`, `retry_history_item`, `queue_control`, `clear_history` | Inspect queued/completed items; add, retry, or manage queue entries and clear history when mutations are enabled. |
| Archive and metadata | `list_archive`, `set_history_archive`, `generate_task_metadata`, `generate_history_nfo` | Search and inspect archive records, archive/unarchive entries, and generate metadata when mutations are enabled. |
| Tasks | `list_tasks`, `get_task`, `inspect_task_url`, `create_tasks`, `patch_task`, `update_task` | Inspect and manage scheduled work; a task may select a preset. Task URL inspection is a preview only. |
| Presets | `list_presets`, `get_preset`, `create_preset`, `patch_preset`, `update_preset` | Inspect and manage reusable per-download authentication and settings when mutations are enabled. |

## Requirements

- Node.js 20 or newer.
- Network access from the process running this server to your ytptube HTTP API.
- The API base URL, including any reverse-proxy path prefix. For example, both `http://127.0.0.1:8080` and `https://media.example.net/ytptube` are valid forms when they match your deployment.

## Install and build

```sh
git clone <your-fork-or-checkout-url> ytptube-mcp
cd ytptube-mcp
npm ci
cp .env.example .env
# Edit .env and set YTPTUBE_BASE_URL.
npm run build
```

The build produces `dist/index.js`. Re-run `npm run build` after changing the server source.

## Connection and authentication

`YTPTUBE_BASE_URL` is required. Set it to the root of the API you want to use, preserving any reverse-proxy prefix:

```dotenv
YTPTUBE_BASE_URL=https://media.example.net/ytptube
```

Authentication is optional. If used, set **both** `YTPTUBE_USERNAME` and `YTPTUBE_PASSWORD`; setting only one is a configuration error. Never commit `.env`, copied configuration files, or credentials to source control.

`YTPTUBE_AUTH_MODE` defaults to `basic`. In that mode the server sends a URL-safe Base64 encoding of `username:password` as `Authorization: Basic ...` on every API call. Set `YTPTUBE_AUTH_MODE=apikey` only for an API/proxy that expects the same encoded credential as the `?apikey=` fallback query parameter instead.

`YTPTUBE_TIMEOUT_MS` is optional and defaults to `30000`. It must be an integer from `100` through `300000`; increase it only when the API/proxy genuinely needs more time.

## Mutation safety

`YTPTUBE_ALLOW_MUTATIONS=false` is the default. In this mode the server blocks every state-changing request **before it makes a network call**. Reading/inspection tools continue to work.

Set this value to the exact string `true` only when you intend to allow changes:

```dotenv
YTPTUBE_ALLOW_MUTATIONS=true
```

This gate covers adds and retries, queue actions, history clearing, archive mutations, task and preset changes, and metadata updates. Treat it as a least-privilege switch: use the default unless a client must make a change. Clearing history keeps media unless the request explicitly asks to delete media.

## Tasks and configuration limits

- Task URL inspection is a preview; the ytptube API does not provide a scheduled-task “run now” endpoint.
- Global yt-dlp options are available through the documented API as read-only data. This server does not write global options.
- Per-download authentication and settings belong in preset inputs, not task create/update. A task can select a preset, but task create/update rejects `cookies` and arbitrary `config` fields.
- File browser/streaming, terminal or system administration, global configuration writes, notifications, task/preset deletion, and SSE are intentionally outside this server’s scope.

## Codex configuration

Build the project first, then add a stdio server entry using the absolute path to the compiled file. Keep credentials in the environment rather than in this configuration file when possible.

```toml
[mcp_servers.ytptube]
command = "node"
args = ["/absolute/path/to/ytptube-mcp/dist/index.js"]

[mcp_servers.ytptube.env]
YTPTUBE_BASE_URL = "https://media.example.net/ytptube"
YTPTUBE_ALLOW_MUTATIONS = "false"
# Set both values together only if the API needs authentication.
# YTPTUBE_USERNAME = "your-user"
# YTPTUBE_PASSWORD = "your-password"
# YTPTUBE_AUTH_MODE = "basic"
```

For a local checkout at `/Users/alex/GitHub/ytptube-mcp`, replace the argument with `/Users/alex/GitHub/ytptube-mcp/dist/index.js`. Do not copy real secrets into documentation, committed config files, or shared shell history.

## Recovery

If a client reports that a mutation is unavailable, first confirm it does not need to change state. If it does, set `YTPTUBE_ALLOW_MUTATIONS=true`, restart the stdio server/client so it receives the setting, perform the change, then return the setting to `false` and restart again. If authentication fails, verify that the base URL includes the correct proxy prefix and that both credential variables are set with the intended `YTPTUBE_AUTH_MODE`.
