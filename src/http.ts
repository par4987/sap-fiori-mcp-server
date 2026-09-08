import http from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "./config.js";
import { createMcpServer } from "./server.js";
import { logger } from "./logger.js";

const MCP_PROTOCOL_HEADER = "mcp-session-id";
const ALLOWED_HEADERS = `content-type, accept, ${MCP_PROTOCOL_HEADER}, x-api-key, authorization, mcp-protocol-version, last-event-id`;

/**
 * DNS-rebinding protection (MCP transport security requirement).
 *
 * A browser page on any origin can POST to a locally bound server; without an Origin check
 * a malicious page could drive this server through the victim's own machine. Requests with no
 * Origin header (curl, MCP clients, IDE extensions) are allowed — the header is browser-set.
 */
export function isOriginAllowed(origin: string | undefined, config: AppConfig): boolean {
  if (!origin) return true; // non-browser client
  if (config.allowedOrigins.includes("*")) return true;
  if (config.allowedOrigins.some((o) => o.toLowerCase() === origin.toLowerCase())) return true;
  try {
    const { hostname, protocol } = new URL(origin);
    if (protocol !== "http:" && protocol !== "https:") return false;
    // loopback origins are the local-development case this transport is meant for
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
  } catch {
    return false;
  }
}

/** Stateless HTTP Streamable transport: each request gets its own server+transport pair. */
export function startHttpServer(config: AppConfig): Promise<http.Server> {
  const httpServer = http.createServer(async (req, res) => {
    const origin = req.headers.origin as string | undefined;

    if (!isOriginAllowed(origin, config)) {
      logger.warn("rejected request with disallowed Origin", { origin });
      res.writeHead(403, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: `Origin '${origin}' is not allowed. Set SAP_FIORI_MCP_ALLOWED_ORIGINS to permit it (comma separated, '*' disables the check).`
        })
      );
      return;
    }

    // CORS: echo the validated origin instead of a blanket wildcard
    if (origin) {
      res.setHeader("access-control-allow-origin", origin);
      res.setHeader("vary", "origin");
    }
    res.setHeader("access-control-allow-headers", ALLOWED_HEADERS);
    res.setHeader("access-control-expose-headers", MCP_PROTOCOL_HEADER);
    res.setHeader("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", server: config.serverName, version: config.serverVersion }));
      return;
    }
    if (url.pathname !== "/mcp") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Use POST /mcp (MCP Streamable HTTP). GET /health returns server status." }));
      return;
    }

    // API key check (when configured)
    if (config.apiKey) {
      const provided =
        (req.headers["x-api-key"] as string | undefined) ||
        (req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : undefined);
      if (provided !== config.apiKey) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized: missing or invalid API key (x-api-key header or Authorization: Bearer)" }));
        return;
      }
    }

    // Stateless mode: new transport per request
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true
    });

    let instance: McpServer | undefined;
    res.on("close", () => {
      transport.close().catch(() => undefined);
      instance?.close().catch(() => undefined);
    });

    try {
      instance = createMcpServer(config);
      await instance.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      logger.error("HTTP request failed", error);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
      }
      res.end(JSON.stringify({ error: "Internal server error" }));
    }
  });

  return new Promise((resolve, reject) => {
    httpServer.listen(config.httpPort, config.httpHost, () => {
      logger.info(`HTTP MCP server listening on http://${config.httpHost}:${config.httpPort}/mcp`);
      console.error(`[${config.serverName}] HTTP MCP server listening on http://${config.httpHost}:${config.httpPort}/mcp`);
      resolve(httpServer);
    });
    httpServer.on("error", reject);
  });
}
