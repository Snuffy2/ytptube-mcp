import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it.each(["http://ytptube.test", "https://ytptube.test/root/path/"])(
    "accepts HTTP(S) base URL %s and defaults mutations off",
    (baseUrl) => {
      const config = loadConfig({ YTPTUBE_BASE_URL: baseUrl });

      expect(config.baseUrl.href).toBe(`${baseUrl.replace(/\/$/, "")}/`);
      expect(config.authMode).toBe("basic");
      expect(config.allowMutations).toBe(false);
    },
  );

  it.each([
    [undefined, "YTPTUBE_BASE_URL is required"],
    ["ftp://ytptube.test", "YTPTUBE_BASE_URL must use http or https"],
    ["not a URL", "Invalid URL"],
  ])("rejects invalid base URL %s", (baseUrl, message) => {
    expect(() => loadConfig({ YTPTUBE_BASE_URL: baseUrl })).toThrow(message);
  });

  it.each([
    [{ YTPTUBE_USERNAME: "user" }, "username without password"],
    [{ YTPTUBE_PASSWORD: "password" }, "password without username"],
  ])("rejects incomplete credentials: %s", (credentials, _description) => {
    expect(() =>
      loadConfig({ YTPTUBE_BASE_URL: "https://ytptube.test", ...credentials }),
    ).toThrow(
      "YTPTUBE_USERNAME and YTPTUBE_PASSWORD must be provided together",
    );
  });

  it("enables mutations only for an explicit true value", () => {
    expect(
      loadConfig({
        YTPTUBE_BASE_URL: "https://ytptube.test",
        YTPTUBE_ALLOW_MUTATIONS: "true",
      }).allowMutations,
    ).toBe(true);
    expect(
      loadConfig({
        YTPTUBE_BASE_URL: "https://ytptube.test",
        YTPTUBE_ALLOW_MUTATIONS: "TRUE",
      }).allowMutations,
    ).toBe(false);
  });
});
