import { describe, expect, it, vi } from "vitest";

import { YtptubeApiError, YtptubeClient } from "../src/client.js";
import type { Config } from "../src/config.js";

function config(overrides: Partial<Config> = {}): Config {
  return {
    baseUrl: new URL("https://ytptube.test/root/api/"),
    username: "u¾",
    password: "p",
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
  it("preserves the base path and sends padded standard Base64 Basic auth on every request", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ ok: true }));
    const client = new YtptubeClient(config(), fetchImpl);
    // This vector requires padding and uses `+`, distinguishing standard Base64
    // from the unpadded URL-safe variant rejected by the backend decoder.
    const expectedCredential = "dcK+OnA=";

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
    const expectedCredential = "dcK+OnA=";

    await client.request("queue", { method: "POST", query: { format: "mp4" } });

    const [url, init] = fetchImpl.mock.calls[0]!;
    const parsedUrl = new URL(String(url));
    expect(parsedUrl.searchParams.get("apikey")).toBe(expectedCredential);
    expect(String(url)).toContain("apikey=dcK%2BOnA%3D");
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

  it("keeps the timeout active while consuming the response body", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => ({
        bodyUsed: false,
        headers: new Headers({ "content-type": "application/json" }),
        ok: true,
        status: 200,
        text: () => new Promise<string>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const error = new Error("body read aborted");
            error.name = "AbortError";
            reject(error);
          }, { once: true });
        }),
      }) as Response);
      const client = new YtptubeClient(config({ timeoutMs: 10 }), fetchImpl);

      const request = client.request("history");
      const timedOut = expect(request).rejects.toMatchObject({
        name: "YtptubeApiError",
        message: "YTPTube request timed out",
        code: "TIMEOUT",
      });
      await vi.advanceTimersByTimeAsync(10);

      await timedOut;
    } finally {
      vi.useRealTimers();
    }
  });
});
