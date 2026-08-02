#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { loadConfig } from "./config.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const server = createServer(config);
  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  // stderr is safe for operator-facing startup failures; stdout is MCP protocol only.
  process.stderr.write(`ytptube-mcp: ${error instanceof Error ? error.message : "startup failed"}\n`);
  process.exitCode = 1;
});
