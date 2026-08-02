import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { YtptubeClient } from "../src/client.js";
import type { Config } from "../src/config.js";
import { createServer } from "../src/server.js";

interface Harness {
  client: Client;
  request: ReturnType<typeof vi.fn<YtptubeClient["request"]>>;
  close: () => Promise<void>;
}

const openHarnesses: Harness[] = [];

async function harness(allowMutations: boolean): Promise<Harness> {
  const config: Config = {
    baseUrl: new URL("https://ytptube.test/base/"),
    authMode: "basic",
    allowMutations,
    timeoutMs: 1_000,
  };
  const request = vi
    .fn<YtptubeClient["request"]>()
    .mockResolvedValue({ ok: true });
  const server = createServer(config, { request } as unknown as YtptubeClient);
  const client = new Client({ name: "ytptube-mcp-tests", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  const result = {
    client,
    request,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
  openHarnesses.push(result);
  return result;
}

function text(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const block = (result as { content: Array<{ type: string; text?: string }> })
    .content[0];
  if (block?.type !== "text") throw new Error("Expected a text tool result");
  if (block.text === undefined) throw new Error("Expected text content");
  return block.text;
}

afterEach(async () => {
  await Promise.all(openHarnesses.splice(0).map(({ close }) => close()));
});

describe("YTPTube MCP tools", () => {
  it("blocks mutations before making a request while keeping read-only inspection available", async () => {
    const { client, request } = await harness(false);

    const mutations = [
      [
        "ytptube_add_downloads",
        { items: { url: "https://video.test/watch/1" } },
      ],
      ["ytptube_retry_history_item", { id: "7" }],
      ["ytptube_queue_control", { action: "pause", ids: ["7"] }],
      ["ytptube_clear_history", { type: "done", ids: ["7"] }],
      ["ytptube_set_history_archive", { id: "7", archived: true }],
      ["ytptube_generate_task_metadata", { id: 7 }],
      ["ytptube_generate_history_nfo", { id: 7 }],
      [
        "ytptube_create_tasks",
        { tasks: { name: "task", url: "https://video.test/watch/1" } },
      ],
      [
        "ytptube_patch_task",
        { id: 7, changes: { url: "https://video.test/watch/2" } },
      ],
      [
        "ytptube_update_task",
        { id: 7, task: { name: "task", url: "https://video.test/watch/2" } },
      ],
      ["ytptube_create_preset", { preset: { name: "audio" } }],
      ["ytptube_patch_preset", { id: 7, changes: { description: "updated" } }],
      ["ytptube_update_preset", { id: 7, preset: { name: "audio" } }],
    ] as const;
    for (const [name, arguments_] of mutations) {
      const blocked = await client.callTool({ name, arguments: arguments_ });
      expect(text(blocked), name).toContain("MUTATIONS_DISABLED");
    }
    expect(request).not.toHaveBeenCalled();

    await client.callTool({
      name: "ytptube_inspect_url",
      arguments: { url: "https://video.test/watch/1" },
    });
    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenLastCalledWith("/api/yt-dlp/url/info", {
      query: { url: "https://video.test/watch/1" },
    });
  });

  it.each([
    [{ type: "done", ids: ["9"] }, false],
    [{ type: "done", ids: ["9"], delete_media: true }, true],
  ])(
    "maps clear-history media deletion opt-in %#",
    async (arguments_, removeFile) => {
      const { client, request } = await harness(true);

      await client.callTool({
        name: "ytptube_clear_history",
        arguments: arguments_,
      });

      expect(request).toHaveBeenCalledWith("/api/history", {
        method: "DELETE",
        body: {
          type: "done",
          ids: ["9"],
          status: undefined,
          remove_file: removeFile,
        },
      });
    },
  );

  it("previews a task only through /api/tasks/inspect", async () => {
    const { client, request } = await harness(false);

    await client.callTool({
      name: "ytptube_inspect_task_url",
      arguments: { url: "https://video.test/watch/1" },
    });

    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith("/api/tasks/inspect", {
      method: "POST",
      body: {
        url: "https://video.test/watch/1",
        static_only: false,
      },
    });
    expect(request.mock.calls.some(([path]) => path === "/api/history")).toBe(
      false,
    );
  });

  it("retries by reading the item and re-queueing only documented download fields", async () => {
    const { client, request } = await harness(true);
    request
      .mockResolvedValueOnce({
        id: "stored-id",
        url: "https://video.test/watch/1",
        preset: "audio",
        folder: "/media",
        cookies: "private-cookie",
        template: "%(title)s",
        cli: "--no-playlist",
        extras: { ignore_conditions: ["has_archive"] },
        auto_start: false,
        status: "error",
        created_at: "yesterday",
        password: "must-not-forward",
      })
      .mockResolvedValueOnce({ queued: true });

    await client.callTool({
      name: "ytptube_retry_history_item",
      arguments: { id: "stored-id" },
    });

    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0]?.[0]).toBe("/api/history/stored-id");
    expect(request.mock.calls[1]).toEqual([
      "/api/history",
      {
        method: "POST",
        body: {
          url: "https://video.test/watch/1",
          preset: "audio",
          folder: "/media",
          cookies: "private-cookie",
          template: "%(title)s",
          extras: { ignore_conditions: ["has_archive"] },
          auto_start: false,
        },
      },
    ]);
  });

  it("preserves only documented download extras and rejects arbitrary or raw CLI extras", async () => {
    const { client, request } = await harness(true);

    await client.callTool({
      name: "ytptube_add_downloads",
      arguments: {
        items: {
          url: "https://video.test/watch/1",
          extras: { ignore_conditions: ["has_archive", "*"] },
        },
      },
    });
    expect(request).toHaveBeenCalledWith("/api/history", {
      method: "POST",
      body: {
        url: "https://video.test/watch/1",
        extras: { ignore_conditions: ["has_archive", "*"] },
      },
    });

    request.mockClear();
    for (const extras of [
      { cli: "--exec unsafe" },
      { args: ["--exec", "unsafe"] },
      { nested: { cli: "unsafe" } },
      { ignore_conditions: [], cli: "--exec unsafe" },
      { ignore_conditions: [] },
      { ignore_conditions: [""] },
    ]) {
      const response = await client.callTool({
        name: "ytptube_add_downloads",
        arguments: { items: { url: "https://video.test/watch/1", extras } },
      });
      expect(response.isError).toBe(true);
    }
    expect(request).not.toHaveBeenCalled();
  });

  it("accepts numeric bulk history IDs and normalizes both write payloads to strings", async () => {
    const { client, request } = await harness(true);

    await client.callTool({
      name: "ytptube_queue_control",
      arguments: { action: "front", ids: [0, 7, "9"] },
    });
    expect(request).toHaveBeenLastCalledWith("/api/history/position", {
      method: "POST",
      body: { ids: ["0", "7", "9"], position: "front" },
    });

    await client.callTool({
      name: "ytptube_clear_history",
      arguments: { type: "done", ids: [0, 7, "9"] },
    });
    expect(request).toHaveBeenLastCalledWith("/api/history", {
      method: "DELETE",
      body: {
        type: "done",
        ids: ["0", "7", "9"],
        status: undefined,
        remove_file: false,
      },
    });
  });

  it.each([
    [
      "ytptube_add_downloads",
      { items: { url: "https://video.test/watch/1", cli: "--exec unsafe" } },
    ],
    [
      "ytptube_create_tasks",
      {
        tasks: {
          name: "task",
          url: "https://video.test/watch/1",
          cli: "--exec unsafe",
        },
      },
    ],
    ["ytptube_patch_task", { id: 7, changes: { cli: "--exec unsafe" } }],
    [
      "ytptube_update_task",
      {
        id: 7,
        task: {
          name: "task",
          url: "https://video.test/watch/1",
          cli: "--exec unsafe",
        },
      },
    ],
    [
      "ytptube_create_preset",
      { preset: { name: "audio", cli: "--exec unsafe" } },
    ],
    ["ytptube_patch_preset", { id: 7, changes: { cli: "--exec unsafe" } }],
    [
      "ytptube_update_preset",
      { id: 7, preset: { name: "audio", cli: "--exec unsafe" } },
    ],
  ])(
    "rejects raw CLI input for write tool %s without a request",
    async (name, arguments_) => {
      const { client, request } = await harness(true);

      const response = await client.callTool({ name, arguments: arguments_ });

      expect(response.isError).toBe(true);
      expect(request).not.toHaveBeenCalled();
    },
  );

  it("rejects raw CLI input for URL inspection without a request", async () => {
    const { client, request } = await harness(false);

    const response = await client.callTool({
      name: "ytptube_inspect_url",
      arguments: { url: "https://video.test/watch/1", args: "--exec unsafe" },
    });

    expect(response.isError).toBe(true);
    expect(text(response)).toContain("Input validation error");
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects raw CLI input with mutations disabled without a request", async () => {
    const { client, request } = await harness(false);

    const response = await client.callTool({
      name: "ytptube_create_preset",
      arguments: { preset: { name: "audio", cli: "--exec unsafe" } },
    });

    expect(response.isError).toBe(true);
    expect(request).not.toHaveBeenCalled();
  });

  it("mutation-gates metadata generation", async () => {
    const blocked = await harness(false);
    expect(
      text(
        await blocked.client.callTool({
          name: "ytptube_generate_task_metadata",
          arguments: { id: 7 },
        }),
      ),
    ).toContain("MUTATIONS_DISABLED");
    expect(blocked.request).not.toHaveBeenCalled();

    const allowed = await harness(true);
    await allowed.client.callTool({
      name: "ytptube_generate_task_metadata",
      arguments: { id: 7 },
    });
    expect(allowed.request).toHaveBeenCalledWith("/api/tasks/7/metadata", {
      method: "POST",
    });
  });

  it("requires task names and never forwards unsupported task fields", async () => {
    const { client, request } = await harness(true);

    const missingName = await client.callTool({
      name: "ytptube_create_tasks",
      arguments: { tasks: { url: "https://video.test/watch/1" } },
    });
    expect(missingName.isError).toBe(true);
    expect(request).not.toHaveBeenCalled();

    const unsupported = await client.callTool({
      name: "ytptube_create_tasks",
      arguments: {
        tasks: {
          name: "daily download",
          url: "https://video.test/watch/1",
          cookies: "must-not-forward",
          config: { token: "must-not-forward" },
        },
      },
    });
    expect(unsupported.isError).toBe(true);
    expect(request).not.toHaveBeenCalled();

    const tools = await client.listTools();
    const createTask = tools.tools.find(
      ({ name }) => name === "ytptube_create_tasks",
    );
    const taskSchemaText = JSON.stringify(createTask?.inputSchema);
    expect(taskSchemaText).not.toContain('"cookies"');
    expect(taskSchemaText).not.toContain('"config"');
  });

  it("publishes the strict nested mutation payload contracts", async () => {
    const { client } = await harness(false);
    const tools = await client.listTools();
    const schemaText = (name: string): string =>
      JSON.stringify(
        tools.tools.find((tool) => tool.name === name)?.inputSchema,
      );

    const downloads = schemaText("ytptube_add_downloads");
    expect(downloads).toContain('"required":["url"]');
    for (const field of [
      "url",
      "preset",
      "folder",
      "cookies",
      "template",
      "auto_start",
      "extras",
    ]) {
      expect(downloads).toContain(`"${field}"`);
    }

    const tasks = [
      schemaText("ytptube_create_tasks"),
      schemaText("ytptube_patch_task"),
      schemaText("ytptube_update_task"),
    ];
    expect(tasks[0]).toContain('"required":["name","url"]');
    for (const schema of tasks) {
      for (const field of [
        "name",
        "url",
        "timer",
        "preset",
        "folder",
        "template",
        "auto_start",
        "handler_enabled",
        "enabled",
      ]) {
        expect(schema).toContain(`"${field}"`);
      }
    }

    const presets = [
      schemaText("ytptube_create_preset"),
      schemaText("ytptube_patch_preset"),
      schemaText("ytptube_update_preset"),
    ];
    expect(presets[0]).toContain('"required":["name"]');
    expect(presets[2]).toContain('"required":["name"]');
    for (const schema of presets) {
      for (const field of [
        "name",
        "description",
        "folder",
        "template",
        "cookies",
      ]) {
        expect(schema).toContain(`"${field}"`);
      }
      expect(schema).not.toContain('"cli"');
    }
  });

  it.each(["ytptube_get_task", "ytptube_get_preset"])(
    "rejects string IDs for %s without sending a request",
    async (name) => {
      const { client, request } = await harness(false);

      const result = await client.callTool({ name, arguments: { id: "7" } });

      expect(request).not.toHaveBeenCalled();
      expect(text(result)).toMatch(/invalid|number/i);
    },
  );

  it.each([
    "ytptube_generate_task_metadata",
    "ytptube_patch_task",
    "ytptube_update_task",
    "ytptube_patch_preset",
    "ytptube_update_preset",
  ])("publishes and enforces a numeric ID for %s", async (name) => {
    const { client, request } = await harness(true);
    const tools = await client.listTools();
    const tool = tools.tools.find((candidate) => candidate.name === name);
    const idSchema = (
      tool?.inputSchema as { properties?: { id?: { type?: string } } }
    ).properties?.id;

    expect(idSchema?.type).toBe("integer");
    const result = await client.callTool({ name, arguments: { id: "7" } });
    expect(result.isError).toBe(true);
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    "ytptube_queue_control",
    "ytptube_set_history_archive",
    "ytptube_generate_history_nfo",
  ])("publishes %s as potentially destructive", async (name) => {
    const { client } = await harness(false);
    const tools = await client.listTools();
    const tool = tools.tools.find((candidate) => candidate.name === name);

    expect(tool?.annotations?.destructiveHint).toBe(true);
  });

  it("rejects invalid disabled-mutation payloads without a request", async () => {
    const { client, request } = await harness(false);

    for (const [name, arguments_] of [
      ["ytptube_add_downloads", { items: { url: "file:///etc/passwd" } }],
      [
        "ytptube_create_tasks",
        { tasks: { name: "unsafe", url: "data:text/plain,secret" } },
      ],
      [
        "ytptube_patch_task",
        { id: 7, changes: { url: "ftp://video.test/file" } },
      ],
      ["ytptube_update_task", { id: 7, task: { url: "not-a-url" } }],
    ] as const) {
      const blocked = await client.callTool({ name, arguments: arguments_ });
      expect(blocked.isError, name).toBe(true);
    }
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    ["ytptube_inspect_url", { url: "file:///etc/passwd" }],
    ["ytptube_inspect_task_url", { url: "data:text/plain,secret" }],
  ])(
    "rejects unsafe URL schemes for read-only tool %s",
    async (name, arguments_) => {
      const { client, request } = await harness(false);

      const response = await client.callTool({ name, arguments: arguments_ });

      expect(response.isError).toBe(true);
      expect(text(response)).toMatch(/http|https/i);
      expect(request).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["ytptube_add_downloads", { items: { url: "file:///etc/passwd" } }],
    [
      "ytptube_create_tasks",
      { tasks: { name: "unsafe", url: "data:text/plain,secret" } },
    ],
    [
      "ytptube_patch_task",
      { id: 7, changes: { url: "ftp://video.test/file" } },
    ],
    [
      "ytptube_update_task",
      { id: 7, task: { name: "unsafe", url: "file:///etc/passwd" } },
    ],
  ])(
    "rejects unsafe URL schemes for enabled mutation %s",
    async (name, arguments_) => {
      const { client, request } = await harness(true);

      const response = await client.callTool({ name, arguments: arguments_ });

      expect(response.isError).toBe(true);
      expect(text(response)).toMatch(/http|https/i);
      expect(request).not.toHaveBeenCalled();
    },
  );

  it("accepts HTTPS download URLs", async () => {
    const { client, request } = await harness(true);
    const item = { url: "https://video.test/watch/1" };

    const response = await client.callTool({
      name: "ytptube_add_downloads",
      arguments: { items: item },
    });

    expect(response.isError).not.toBe(true);
    expect(request).toHaveBeenCalledWith("/api/history", {
      method: "POST",
      body: item,
    });
  });

  it("redacts nested secrets from successful and structured-error result text", async () => {
    const success = await harness(false);
    success.request.mockResolvedValueOnce({
      status: "ok",
      nested: { cookie: "cookie-value", token: "token-value" },
    });
    const successText = text(
      await success.client.callTool({ name: "ytptube_ping", arguments: {} }),
    );
    expect(successText).toContain('"status": "ok"');
    expect(successText).not.toContain("cookie-value");
    expect(successText).not.toContain("token-value");

    const failure = await harness(false);
    const { YtptubeApiError } = await import("../src/client.js");
    failure.request.mockRejectedValueOnce(
      new YtptubeApiError("rejected", 403, "DENIED", {
        authorization: "authorization-value",
        nested: { password: "password-value", apikey: "apikey-value" },
      }),
    );
    const failureText = text(
      await failure.client.callTool({ name: "ytptube_ping", arguments: {} }),
    );
    expect(failureText).toContain("DENIED");
    expect(failureText).not.toContain("authorization-value");
    expect(failureText).not.toContain("password-value");
    expect(failureText).not.toContain("apikey-value");
  });

  it("removes URL userinfo from structured responses while preserving safe URL details", async () => {
    const { client, request } = await harness(false);
    request.mockResolvedValueOnce({
      log: "request failed for https://worker:password@ytptube.test/api/logs?limit=5",
    });

    const responseText = text(
      await client.callTool({ name: "ytptube_list_logs", arguments: {} }),
    );

    expect(responseText).not.toContain("worker:password");
    expect(responseText).toContain("https://ytptube.test/api/logs?limit=5");
  });

  it("redacts authentication and cookie headers from logs and structured API errors", async () => {
    const secrets = {
      basic: "basic-secret-value",
      bearer: "bearer-secret-value",
      cookie: "session=cookie-secret-value; theme=dark",
      setCookie: "session=set-cookie-secret-value; HttpOnly; Secure",
    };
    const headerText = [
      `Authorization: Basic ${secrets.basic}`,
      `Authorization: Bearer ${secrets.bearer}`,
      `Cookie: ${secrets.cookie}`,
      `Set-Cookie: ${secrets.setCookie}`,
    ].join("\n");

    const logs = await harness(false);
    logs.request.mockResolvedValueOnce({
      status: "worker continuing normally",
      log: `download inspection started\n${headerText}\ndownload inspection complete`,
    });
    const logText = text(
      await logs.client.callTool({ name: "ytptube_list_logs", arguments: {} }),
    );
    expect(logText).toContain("worker continuing normally");
    expect(logText).toContain("download inspection complete");
    for (const secret of Object.values(secrets)) {
      expect(logText).not.toContain(secret);
    }

    const failure = await harness(false);
    const { YtptubeApiError } = await import("../src/client.js");
    failure.request.mockRejectedValueOnce(
      new YtptubeApiError("upstream rejected request", 401, "AUTH_FAILED", {
        operation: "task inspection remains available",
        diagnostic: `backend response headers\n${headerText}\nretry is permitted`,
      }),
    );
    const failureText = text(
      await failure.client.callTool({
        name: "ytptube_inspect_task_url",
        arguments: {
          url: "https://video.test/watch/1",
        },
      }),
    );
    expect(failureText).toContain("AUTH_FAILED");
    expect(failureText).toContain("task inspection remains available");
    expect(failureText).toContain("retry is permitted");
    for (const secret of Object.values(secrets)) {
      expect(failureText).not.toContain(secret);
    }
  });
});
