#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { SverseClient } from './client.js';
import { ConfigError, describeConfig, loadConfig } from './config.js';
import { registerTools } from './tools/index.js';

export const VERSION = '0.1.0';

/**
 * Loads configuration, wires the 7 tools, and serves stdio.
 *
 * stdout carries the JSON-RPC framing: a single `console.log` corrupts the stream and the client
 * disconnects with an opaque error, so every diagnostic goes to stderr.
 */
async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`sverse-mcp: ${error.message}\n`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  const server = new McpServer({ name: 'sverse', version: VERSION }, { capabilities: { tools: {} } });
  registerTools(server, new SverseClient(config));

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`${describeConfig(config)} (v${VERSION}, 7 tools)\n`);

  const shutdown = () => {
    server.close().catch(() => undefined);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error: unknown) => {
  process.stderr.write(`sverse-mcp: fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exitCode = 1;
});
