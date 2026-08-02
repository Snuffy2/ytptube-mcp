import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadCheckoutEnvironment } from "../src/index.js";

describe("loadCheckoutEnvironment", () => {
  it("loads a checkout-local env file without overriding explicit variables", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ytptube-mcp-env-"));
    try {
      const envPath = join(directory, ".env");
      await writeFile(
        envPath,
        [
          "YTPTUBE_BASE_URL=https://from-file.test",
          "YTPTUBE_TIMEOUT_MS=45000",
        ].join("\n"),
      );
      const env: NodeJS.ProcessEnv = {
        YTPTUBE_BASE_URL: "https://explicit.test",
      };

      loadCheckoutEnvironment(env, envPath);

      expect(env.YTPTUBE_BASE_URL).toBe("https://explicit.test");
      expect(env.YTPTUBE_TIMEOUT_MS).toBe("45000");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
