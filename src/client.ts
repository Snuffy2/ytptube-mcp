import type { Config } from "./config.js";

export class YtptubeApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly code?: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "YtptubeApiError";
  }
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
}

export class YtptubeClient {
  constructor(
    private readonly config: Config,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async request(path: string, options: RequestOptions = {}): Promise<unknown> {
    const basePath = this.config.baseUrl.pathname.replace(/\/$/, "");
    const url = new URL(this.config.baseUrl.origin);
    url.pathname = `${basePath}/${path.replace(/^\//, "")}`;
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const headers = new Headers({ Accept: "application/json" });
    if (options.body !== undefined) headers.set("Content-Type", "application/json");
    if (this.config.username !== undefined && this.config.password !== undefined) {
      // YTPTube decodes both transports with Python's standard b64decode. Keep
      // padding and the standard alphabet; URLSearchParams safely escapes it.
      const credential = Buffer.from(`${this.config.username}:${this.config.password}`).toString("base64");
      if (this.config.authMode === "apikey") url.searchParams.set("apikey", credential);
      else headers.set("Authorization", `Basic ${credential}`);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: options.method ?? "GET",
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new YtptubeApiError("YTPTube request timed out", undefined, "TIMEOUT");
      }
      throw new YtptubeApiError("YTPTube request failed", undefined, "TRANSPORT_ERROR");
    } finally {
      clearTimeout(timer);
    }

    const contentType = response.headers.get("content-type") ?? "";
    // A conforming fetch returns a fresh Response. Tolerate reused test/custom-fetch
    // responses so transport adapters cannot turn a successful empty reply into a crash.
    const text = response.bodyUsed ? "" : await response.text();
    let payload: unknown = text;
    if (contentType.includes("json") || text.trim().startsWith("{") || text.trim().startsWith("[")) {
      try {
        payload = text ? JSON.parse(text) : null;
      } catch {
        if (response.ok) throw new YtptubeApiError("YTPTube returned invalid JSON", response.status, "INVALID_RESPONSE");
      }
    }
    if (!response.ok) {
      const data = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
      const message = typeof data.error === "string" ? data.error : `YTPTube request failed with HTTP ${response.status}`;
      throw new YtptubeApiError(message, response.status, typeof data.code === "string" ? data.code : undefined, data.detail);
    }
    return payload;
  }
}
