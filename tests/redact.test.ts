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

  it("removes HTTP URL userinfo while preserving the URL destination", () => {
    expect(
      redact("request failed for https://worker:password@ytptube.test/api/logs?limit=5#recent"),
    ).toBe("request failed for https://ytptube.test/api/logs?limit=5#recent");
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

  it.each([
    ["Authorization", 'Digest username=\\"alice\\", response=\\"authorization-secret\\"'],
    ["X-API-Key", 'key-id=\\"safe-id\\", secret=\\"api-key-secret\\"'],
    ["Cookie", 'session=\\"cookie-secret\\"; theme=light'],
  ])("redacts escape-aware serialized %s values", (header, credential) => {
    const result = redact(`before {"${header}":"${credential}","status":"safe"} after`);
    const text = String(result);

    expect(text).not.toContain(credential);
    expect(text).not.toMatch(/authorization-secret|api-key-secret|cookie-secret/);
    expect(text).toContain('"status":"safe"');
    expect(text).toContain("before");
    expect(text).toContain("after");
  });

  it("redacts an escaped-JSON-like header containing escaped quotes", () => {
    const result = String(redact(
      'before {\\"Authorization\\":\\"Digest username=\\\\\\"alice\\\\\\", response=\\\\\\"escaped-secret\\\\\\"\\",\\"status\\":\\"safe\\"} after',
    ));

    expect(result).not.toContain("escaped-secret");
    expect(result).toContain('\\"status\\":\\"safe\\"');
    expect(result).toContain("before");
    expect(result).toContain("after");
  });

  it("redacts authorization credentials for schemes other than Basic and Bearer", () => {
    expect(redact("Authorization: Digest secret\nrequest failed")).toBe(
      "Authorization: [REDACTED]\nrequest failed",
    );
  });

  it.each([
    [
      "request failed with Authorization: Bearer bearer-secret",
      "request failed with Authorization: [REDACTED]",
      "bearer-secret",
    ],
    [
      'proxy rejected Proxy-Authorization: Digest username="proxy-user", response="proxy-secret"',
      "proxy rejected Proxy-Authorization: [REDACTED]",
      "proxy-secret",
    ],
  ])("redacts inline plaintext authorization headers", (diagnostic, expected, credential) => {
    const result = String(redact(diagnostic));

    expect(result).toBe(expected);
    expect(result).not.toContain(credential);
  });

  it.each([
    [
      "Authorization",
      'Digest username="alice", realm="private area", nonce="n,once", response="credential-secret"',
    ],
    [
      "Authorization",
      'Digest username="alice smith", response="credential with spaces"',
    ],
    [
      "Proxy-Authorization",
      'Digest username="proxy-user", realm="proxy, realm", response="proxy-secret"',
    ],
  ])("redacts the complete plaintext %s value", (header, credential) => {
    const result = String(redact(`${header}: ${credential}\nfollowing line remains`));

    expect(result).toBe(`${header}: [REDACTED]\nfollowing line remains`);
    expect(result).not.toContain(credential);
    for (const value of credential.match(/"([^"]*)"/g) ?? []) {
      expect(result).not.toContain(value.slice(1, -1));
    }
  });

  it("redacts equals-delimited cookie diagnostics", () => {
    expect(redact("Cookie=session=secret\nrequest failed")).toBe(
      "Cookie=[REDACTED]\nrequest failed",
    );
  });

  it("redacts plural cookies in string field and query forms", () => {
    expect(redact("worker failed: cookies=private-cookie retry permitted")).toBe(
      "worker failed: cookies=[REDACTED] retry permitted",
    );
    expect(redact('{"cookies":"private-cookie","status":"safe"}')).toBe(
      '{"cookies":"[REDACTED]","status":"safe"}',
    );
    expect(redact('{\\"cookies\\":\\"private-cookie\\",\\"status\\":\\"safe\\"}')).toBe(
      '{\\"cookies\\":\\"[REDACTED]\\",\\"status\\":\\"safe\\"}',
    );
    expect(redact("/api/tasks?cookies=private-cookie&limit=5")).toBe(
      "/api/tasks?cookies=[REDACTED]&limit=5",
    );
    expect(redact({ cookies: "private-cookie", status: "safe" })).toEqual({
      cookies: "[REDACTED]",
      status: "safe",
    });
  });

  it.each([
    ["password", "password-secret"],
    ["token", "token-secret"],
    ["access_token", "access-token-secret"],
    ["refresh_token", "refresh-token-secret"],
    ["secret", "generic-secret"],
  ])("redacts %s assignments and serialized values in strings", (key, credential) => {
    const result = redact([
      `worker failed: ${key}=${credential} retry permitted`,
      `backend response: {"${key}":"${credential}","status":"denied"}`,
      `escaped response: {\\"${key}\\":\\"${credential}\\"} complete`,
      `request URL: /api/logs?offset=0&${key}=${credential}&limit=5`,
    ]);
    const text = JSON.stringify(result);

    expect(text).not.toContain(credential);
    expect(text).toContain("retry permitted");
    expect(text).toContain("status");
    expect(text).toContain("complete");
    expect(text).toContain("limit=5");
  });
});
