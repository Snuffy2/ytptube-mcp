import { describe, expect, it, vi } from "vitest";

import { YtptubeApiError, YtptubeClient } from "../src/client.js";
import type { Config } from "../src/config.js";

function config(overrides: Partial<Config> = {}): Config {
  return {
    baseUrl: new URL("https://ytptube.test/root/api/"),
    username: "name+/_",
    password: "pass?=word",
    authMode: "basic",
    allowMutations: false,
    timeoutMs: 1_000,
    ...overrides,
  };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("YtptubeClient", () => {
  it("preserves the configured base path and sends URL-safe Basic auth on every request", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ ok: true }));
    const client = new YtptubeClient(config(), fetchImpl);
    const expectedCredential = Buffer.from("name+/_:pass?=word").toString("base64url");

    await client.request("tasks/inspect", { query: { id: 7 } });
    await client.request("/history");

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([
      "https://ytptube.test/root/api/tasks/inspect?id=7",
      "https://ytptube.test/root/api/history",
    ]);
    for (const [, init] of fetchImpl.mock.calls) {
      expect(new Headers(init?.headers).get("Authorization")).toBe(
        `Basic ${expectedCredential}`,
      );
    }
  });

  it("uses the apikey query parameter without an Authorization header", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ ok: true }));
    const client = new YtptubeClient(config({ authMode: "apikey" }), fetchImpl);
    const expectedCredential = Buffer.from("name+/_:pass?=word").toString("base64url");

    await client.request("queue", { method: "POST", query: { format: "mp4" } });

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe(
      `https://ytptube.test/root/api/queue?format=mp4&apikey=${expectedCredential}`,
    );
    expect(new Headers(init?.headers).has("Authorization")).toBe(false);
  });

  it("maps structured API failures without exposing unrelated response fields", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(
        {
          error: "request rejected",
          code: "INVALID_TASK",
          detail: { field: "url", token: "do-not-expose" },
          password: "also-do-not-expose",
        },
        422,
      ),
    );
    const client = new YtptubeClient(config(), fetchImpl);

    const error = await client.request("queue").catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(YtptubeApiError);
    expect(error).toMatchObject({
      message: "request rejected",
      status: 422,
      code: "INVALID_TASK",
      details: { field: "url", token: "do-not-expose" },
    });
    expect(String(error)).not.toContain("also-do-not-expose");
  });

  it("maps transport failures to a stable error without leaking the thrown message", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("connect failed with password=do-not-expose"));
    const client = new YtptubeClient(config(), fetchImpl);

    await expect(client.request("history")).rejects.toMatchObject({
      name: "YtptubeApiError",
      message: "YTPTube request failed",
      code: "TRANSPORT_ERROR",
    });
  });
});
