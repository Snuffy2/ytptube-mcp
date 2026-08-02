#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { config as loadDotenv } from "dotenv";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig } from "./config.js";
import { createServer } from "./server.js";

export function loadCheckoutEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  envPath = fileURLToPath(new URL("../.env", import.meta.url)),
): void {
  loadDotenv({
    path: envPath,
    processEnv: env as Record<string, string>,
    override: false,
    quiet: true,
  });
}

async function main(): Promise<void> {
  loadCheckoutEnvironment();
  const config = loadConfig();
  const server = createServer(config);
  await server.connect(new StdioServerTransport());
}

if (
  process.argv[1] !== undefined &&
  realpathSync(fileURLToPath(import.meta.url)) ===
    realpathSync(resolve(process.argv[1]))
) {
  main().catch((error: unknown) => {
    // stderr is safe for operator-facing startup failures; stdout is MCP protocol only.
    process.stderr.write(
      `ytptube-mcp: ${error instanceof Error ? error.message : "startup failed"}\n`,
    );
    process.exitCode = 1;
  });
}
