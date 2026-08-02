import { describe, expect, it } from "vitest";

import { redact } from "../src/redact.js";

describe("redact", () => {
  it("recursively redacts sensitive keys while preserving safe result data", () => {
    const result = redact({
      title: "safe title",
      cookie: "cookie-value",
      nested: {
        token: "token-value",
        password: "password-value",
        Authorization: "authorization-value",
        apikey: "apikey-value",
        api_key: "api-key-value",
        items: [{ secret: "secret-value", status: "complete" }],
      },
    });
    const text = JSON.stringify(result);

    expect(result).toEqual({
      title: "safe title",
      cookie: "[REDACTED]",
      nested: {
        token: "[REDACTED]",
        password: "[REDACTED]",
        Authorization: "[REDACTED]",
        apikey: "[REDACTED]",
        api_key: "[REDACTED]",
        items: [{ secret: "[REDACTED]", status: "complete" }],
      },
    });
    for (const secret of [
      "cookie-value",
      "token-value",
      "password-value",
      "authorization-value",
      "apikey-value",
      "api-key-value",
      "secret-value",
    ]) {
      expect(text).not.toContain(secret);
    }
  });

  it("redacts apikey query credentials embedded in strings", () => {
    const credential = "dcK+OnA=";
    const result = redact({
      log: `request failed: https://ytptube.test/api/logs?apikey=${credential}&limit=5`,
      error: `backend rejected ?apikey=${credential}`,
      nested: [`result URL: /api/tasks?other=1&apikey=${credential}`],
    });
    const text = JSON.stringify(result);

    expect(text).not.toContain(credential);
    expect(text).toContain("apikey=[REDACTED]");
    expect(text).toContain("limit=5");
  });

  it("redacts serialized authentication and API key headers without removing safe text", () => {
    const secrets = ["basic-secret", "proxy-secret", "api-key-secret", "cookie-secret"];
    const result = redact([
      `response headers: {"Authorization":"Basic ${secrets[0]}","status":"ok"}`,
      `Proxy-Authorization: Bearer ${secrets[1]}\nretry permitted`,
      `X-API-Key='${secrets[2]}' operation=inspect`,
      `{"Cookie":"session=${secrets[3]}","result":"complete"}`,
    ]);
    const text = JSON.stringify(result);

    for (const secret of secrets) expect(text).not.toContain(secret);
    expect(text).toContain("status");
    expect(text).toContain("retry permitted");
    expect(text).toContain("operation=inspect");
    expect(text).toContain("complete");
  });

  it("redacts escaped serialized authorization while preserving surrounding text", () => {
    expect(redact('response {\\"Authorization\\":\\"Basic secret\\"}')).toBe(
      'response {\\"Authorization\\":\\"[REDACTED]\\"}',
    );
  });

  it("redacts authorization credentials for schemes other than Basic and Bearer", () => {
    expect(redact("Authorization: Digest secret\nrequest failed")).toBe(
      "Authorization: Digest [REDACTED]\nrequest failed",
    );
  });

  it("redacts equals-delimited cookie diagnostics", () => {
    expect(redact("Cookie=session=secret\nrequest failed")).toBe(
      "Cookie=[REDACTED]\nrequest failed",
    );
  });
});
