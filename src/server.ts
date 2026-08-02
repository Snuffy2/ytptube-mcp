import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z, type ZodRawShape } from "zod";

import { YtptubeApiError, YtptubeClient, type RequestOptions } from "./client.js";
import type { Config } from "./config.js";
import { redact } from "./redact.js";

type Input = Record<string, unknown>;
type ToolHandler = (input: Input) => Promise<unknown>;

const id = z.union([z.string().min(1), z.number().int().nonnegative()]);
const numericId = z.number().int().positive();
const ids = z.array(z.string().min(1)).min(1);
const page = z.number().int().min(1).optional();
const perPage = z.number().int().min(1).max(200).optional();
const arbitraryObject = z.record(z.unknown());
const httpUrl = z.string().url().refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === "http:" || protocol === "https:";
}, "URL must use http or https");
const download = z.object({
  url: httpUrl,
  preset: z.string().optional(),
  folder: z.string().optional(),
  cookies: z.string().optional(),
  template: z.string().optional(),
  cli: z.string().optional(),
  auto_start: z.boolean().optional(),
  extras: arbitraryObject.optional(),
});
const taskFields = {
  name: z.string().trim().min(1),
  url: httpUrl,
  timer: z.string().optional(),
  preset: z.string().optional(),
  folder: z.string().optional(),
  template: z.string().optional(),
  cli: z.string().optional(),
  auto_start: z.boolean().optional(),
  handler_enabled: z.boolean().optional(),
  enabled: z.boolean().optional(),
};
const taskCreate = z.object(taskFields).strict();
const subsequentTaskCreate = z.object({ ...taskFields, name: taskFields.name.optional() }).strict();
const taskCreatePayload = z.union([
  taskCreate,
  z.tuple([taskCreate]).rest(subsequentTaskCreate),
]);
const taskPatch = z.object({
  ...taskFields,
  name: taskFields.name.optional(),
  url: taskFields.url.optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "changes must not be empty");
const preset = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  folder: z.string().optional(),
  template: z.string().optional(),
  cookies: z.string().optional(),
  cli: z.string().optional(),
});

function result(value: unknown, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(redact(value), null, 2) }], isError };
}

function errorResult(error: unknown) {
  if (error instanceof YtptubeApiError) {
    return result({ error: error.message, code: error.code, status: error.status, detail: error.details }, true);
  }
  return result({ error: error instanceof Error ? error.message : "Unexpected error" }, true);
}

export function createServer(config: Config, client = new YtptubeClient(config)): McpServer {
  const server = new McpServer({ name: "ytptube-mcp", version: "0.1.0" });

  const register = (
    name: string,
    description: string,
    inputSchema: ZodRawShape,
    handler: ToolHandler,
    mutation = false,
    destructive = false,
  ) => {
    server.registerTool(name, {
      description,
      inputSchema,
      annotations: {
        readOnlyHint: !mutation,
        destructiveHint: destructive,
        idempotentHint: !mutation,
        openWorldHint: true,
      },
    }, async (input) => {
      if (mutation && !config.allowMutations) {
        return result({
          error: "Mutations are disabled; set YTPTUBE_ALLOW_MUTATIONS=true to enable this tool",
          code: "MUTATIONS_DISABLED",
        }, true);
      }
      try {
        return result(await handler(input));
      } catch (error) {
        return errorResult(error);
      }
    });
  };

  const call = (path: string, options?: RequestOptions) => client.request(path, options);
  const pathId = (value: unknown) => encodeURIComponent(String(value));

  register("ytptube_ping", "Check whether the configured YTPTube API is reachable.", {}, () => call("/api/ping"));
  register("ytptube_get_system_configuration", "Read YTPTube system configuration. Sensitive fields are recursively redacted.", {}, () => call("/api/system/configuration"));
  register("ytptube_get_ytdlp_options", "Read the active yt-dlp option configuration.", {}, () => call("/api/yt-dlp/options"));
  register("ytptube_validate_cli_options", "Parse and validate yt-dlp CLI options without starting a download.", {
    args: z.string(),
  }, ({ args }) => call("/api/yt-dlp/convert", { method: "POST", body: { args } }));
  register("ytptube_inspect_url", "Inspect URL metadata without adding it to the download queue.", {
    url: httpUrl, preset: z.string().optional(), force: z.boolean().optional(), args: z.string().optional(), entries: z.boolean().optional(),
  }, (input) => call("/api/yt-dlp/url/info", { query: input as RequestOptions["query"] }));
  register("ytptube_list_logs", "Read recent YTPTube application logs (when file logging is enabled).", {
    offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(150).optional(),
  }, (input) => call("/api/logs", { query: input as RequestOptions["query"] }));
  register("ytptube_live_queue", "Read current in-memory queue progress and counts.", {
    limit: z.number().int().min(0).optional(),
  }, (input) => call("/api/history/live", { query: input as RequestOptions["query"] }));
  register("ytptube_list_history", "List a paginated queue or completed-history page.", {
    type: z.enum(["queue", "done"]), page, per_page: perPage, order: z.enum(["ASC", "DESC"]).optional(), status: z.string().optional(),
  }, (input) => call("/api/history", { query: input as RequestOptions["query"] }));
  register("ytptube_get_history_item", "Read one queue or history item by ID.", { id }, ({ id }) => call(`/api/history/${pathId(id)}`));

  register("ytptube_add_downloads", "Add one or more URLs to the download queue.", {
    // Parse the endpoint contract after the local mutation gate.
    items: z.union([arbitraryObject, z.array(arbitraryObject).min(1)]),
  }, ({ items }) => call("/api/history", {
    method: "POST",
    body: z.union([download, z.array(download).min(1)]).parse(items),
  }), true);
  register("ytptube_retry_history_item", "Read a history item and requeue only saved download-request fields.", { id }, async ({ id }) => {
    const stored = await call(`/api/history/${pathId(id)}`) as Record<string, unknown>;
    const allowed = ["url", "preset", "folder", "cookies", "template", "cli", "extras", "auto_start"] as const;
    const body = Object.fromEntries(allowed.filter((key) => stored[key] !== undefined).map((key) => [key, stored[key]]));
    download.parse(body);
    return call("/api/history", { method: "POST", body });
  }, true);
  register("ytptube_queue_control", "Start, pause, force-start, reorder, or cancel queued downloads.", {
    action: z.enum(["start", "pause", "force-start", "front", "back", "cancel"]), ids,
  }, ({ action, ids }) => {
    const position = action === "front" || action === "back";
    return call(position ? "/api/history/position" : `/api/history/${action}`, {
      method: "POST", body: position ? { ids, position: action } : { ids },
    });
  }, true);
  register("ytptube_clear_history", "Delete queue/history records selected by IDs or a status filter; media deletion is opt-in.", {
    type: z.enum(["queue", "done"]), ids: z.array(z.string().min(1)).min(1).optional(), status: z.string().min(1).optional(), delete_media: z.boolean().default(false),
  }, ({ type, ids, status, delete_media }) => {
    if ((ids === undefined) === (status === undefined)) throw new Error("Provide exactly one of ids or status");
    return call("/api/history", { method: "DELETE", body: { type, ids, status, remove_file: delete_media } });
  }, true, true);
  register("ytptube_list_archive", "List archive entries for a preset, optionally filtered by archive IDs.", {
    preset: z.string().min(1), ids: z.array(z.string().min(1)).optional(),
  }, ({ preset, ids }) => call("/api/archiver", { query: { preset: String(preset), ids: Array.isArray(ids) ? ids.join(",") : undefined } }));
  register("ytptube_set_history_archive", "Archive or unarchive a history item using its configured archive file.", {
    id, archived: z.boolean(),
  }, ({ id, archived }) => call(`/api/history/${pathId(id)}/archive`, { method: archived ? "POST" : "DELETE" }), true);
  register("ytptube_generate_task_metadata", "Generate task metadata, NFO, and image sidecar files.", { id: numericId }, ({ id }) => call(`/api/tasks/${pathId(id)}/metadata`, { method: "POST" }), true);
  register("ytptube_generate_history_nfo", "Generate an NFO sidecar for a completed history item.", {
    id, type: z.enum(["tv", "movie"]).default("tv"), overwrite: z.boolean().default(false),
  }, ({ id, type, overwrite }) => call(`/api/history/${pathId(id)}/nfo`, { method: "POST", body: { type, overwrite } }), true);

  register("ytptube_list_tasks", "List scheduled tasks with pagination.", { page, per_page: perPage }, (input) => call("/api/tasks", { query: input as RequestOptions["query"] }));
  register("ytptube_get_task", "Read a scheduled task by numeric ID.", { id: numericId }, ({ id }) => call(`/api/tasks/${pathId(id)}`));
  register("ytptube_inspect_task_url", "Preview the task handler and items for a URL; this only calls /api/tasks/inspect and never queues downloads.", {
    url: httpUrl, preset: z.string().optional(), handler: z.string().optional(), static_only: z.boolean().default(false),
  }, (input) => call("/api/tasks/inspect", { method: "POST", body: input }));
  register("ytptube_create_tasks", "Create one or more scheduled tasks.", {
    // Keep mutation-gate errors deterministic even for incomplete payloads;
    // the endpoint-specific contract is parsed after the local gate.
    tasks: z.union([arbitraryObject, z.array(arbitraryObject).min(1)]),
  }, ({ tasks }) => call("/api/tasks", { method: "POST", body: taskCreatePayload.parse(tasks) }), true);
  register("ytptube_patch_task", "Partially update a scheduled task.", {
    id: numericId, changes: arbitraryObject,
  }, ({ id, changes }) => call(`/api/tasks/${pathId(id)}`, {
    method: "PATCH",
    body: taskPatch.parse(changes),
  }), true);
  register("ytptube_update_task", "Replace a scheduled task using the API PUT contract.", {
    id: numericId, task: arbitraryObject,
  }, ({ id, task }) => call(`/api/tasks/${pathId(id)}`, { method: "PUT", body: taskCreate.parse(task) }), true);

  register("ytptube_list_presets", "List download presets with pagination and sorting.", {
    page, per_page: perPage, sort: z.string().optional(), order: z.string().optional(), exclude_defaults: z.boolean().optional(),
  }, (input) => call("/api/presets", { query: input as RequestOptions["query"] }));
  register("ytptube_get_preset", "Read a download preset by numeric ID.", { id: numericId }, ({ id }) => call(`/api/presets/${pathId(id)}`));
  register("ytptube_create_preset", "Create a download preset.", { preset }, ({ preset }) => call("/api/presets", { method: "POST", body: preset }), true);
  register("ytptube_patch_preset", "Partially update a non-default download preset.", {
    id: numericId, changes: preset.partial().refine((value) => Object.keys(value).length > 0, "changes must not be empty"),
  }, ({ id, changes }) => call(`/api/presets/${pathId(id)}`, { method: "PATCH", body: changes }), true);
  register("ytptube_update_preset", "Replace a non-default download preset using the API PUT contract.", {
    id: numericId, preset,
  }, ({ id, preset }) => call(`/api/presets/${pathId(id)}`, { method: "PUT", body: preset }), true);

  return server;
}
