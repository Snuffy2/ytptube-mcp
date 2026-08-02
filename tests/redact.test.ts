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
});
