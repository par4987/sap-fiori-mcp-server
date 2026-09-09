#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig, SERVER_NAME, SERVER_VERSION } from "./config.js";
import { initLogger, logger } from "./logger.js";
import { createMcpServer } from "./server.js";
import { startHttpServer } from "./http.js";
import { startAdminServer } from "./admin/server.js";

function printHelp(): void {
  process.stdout.write(
    `${SERVER_NAME} v${SERVER_VERSION}

A unified MCP server for SAP Fiori / UI5 / CAP development (from scratch, no SAP packages required).

Usage:
  sap-fiori-mcp [options]

Options:
  --admin           Open the local connection admin panel (127.0.0.1 only) and exit
  --http            Run with HTTP Streamable transport instead of stdio
  --port <n>        HTTP port (default 3001 or SAP_FIORI_MCP_PORT)
  --host <addr>     HTTP bind address (default 127.0.0.1)
  --help, -h        Show this help
  --version, -v     Show version

Environment (see README for the full list):
  LOG_LEVEL=off|error|warn|info|debug
  SAP_BASE_URL, SAP_CLIENT, SAP_USER, SAP_PASSWORD, SAP_SYSTEM_NAME
  SAP_SYSTEMS_FILE (default ~/.sap-fiori-mcp/systems.json)
  SAP_DESTINATIONS_JSON | SAP_DESTINATIONS_FILE | SAP_DESTINATIONS_DIR (BTP destinations)
  BTP_CLIENT_ID, BTP_CLIENT_SECRET, BTP_TOKEN_URL, BTP_DESTINATION_API_URL (Destination Service)
  SAP_FIORI_MCP_WORKSPACE_ROOT, SAP_FIORI_MCP_API_KEY
  SAP_FIORI_MCP_ALLOWED_DOMAINS   outbound host allowlist (empty = unrestricted, supports *.domain.com)
  SAP_FIORI_MCP_ALLOWED_ORIGINS   HTTP mode: accepted browser origins (default: loopback only)
  SAP_FIORI_MCP_TOOL_PREFIX       prefix every tool name, e.g. sapfiori_search_docs
  UI5_DISTRIBUTION=openui5|sapui5, UI5_CDN_URL

MCP endpoints:
  stdio   : default transport for Claude Desktop / Cursor / VS Code / Cline
  http    : POST http://localhost:3001/mcp (Streamable HTTP), GET /health
`
  );
}

function flagValue(argv: string[], flag: string, fallback: string): string {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    printHelp();
    return;
  }
  if (argv.includes("--version") || argv.includes("-v")) {
    process.stdout.write(`${SERVER_NAME} ${SERVER_VERSION}\n`);
    return;
  }

  const config = loadConfig(argv);
  initLogger(config);

  if (argv.includes("--admin")) {
    const admin = await startAdminServer(Number(flagValue(argv, "--port", process.env.SAP_FIORI_MCP_ADMIN_PORT ?? "7392")));
    // the token is printed once and never stored; closing this process invalidates it
    process.stdout.write(`
Connection admin panel ready — open this exact link (it carries a one-time token):

  ${admin.url}

It listens on 127.0.0.1 only. Press Ctrl+C to stop.
`);
    return;
  }
  logger.info("starting", { transport: config.transport, port: config.httpPort, workspace: config.workspaceRoot });

  if (config.transport === "http") {
    await startHttpServer(config);
    // keep process alive
    return;
  }

  // stdio transport (default)
  const server = createMcpServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("stdio server connected");
}

main().catch((error) => {
  logger.error("fatal", error);
  // eslint-disable-next-line no-console
  console.error(`[${SERVER_NAME}] fatal:`, error instanceof Error ? error.message : error);
  process.exit(1);
});
