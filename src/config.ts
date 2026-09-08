import os from "node:os";
import path from "node:path";
import fs from "node:fs";

export type SapSystem = {
  name: string;
  url: string;
  client?: string;
  user?: string;
  password?: string;
  authType?: "basic" | "none";
};

export type TransportMode = "stdio" | "http";

export interface AppConfig {
  serverName: string;
  serverVersion: string;
  transport: TransportMode;
  httpPort: number;
  httpHost: string;
  apiKey?: string;
  logLevel: "off" | "error" | "warn" | "info" | "debug";
  logFile: string;
  dataDir: string;
  workspaceRoot: string;
  ui5CdnUrl: string;
  ui5Distribution: "openui5" | "sapui5";
  ui5TypesCdnUrl: string;
  /** Outbound host allowlist. Empty = unrestricted (see src/net/guard.ts). */
  allowedDomains: string[];
  /** Origins accepted by the HTTP transport (DNS-rebinding protection). */
  allowedOrigins: string[];
  /** Optional prefix applied to every tool name, e.g. "sapfiori_" (avoids clashes with other MCP servers). */
  toolPrefix: string;
  sapSystems: SapSystem[];
  requestTimeoutMs: number;
  noResources: boolean;
}

export const SERVER_NAME = "@pired/sap-fiori-mcp-server";
export const SERVER_VERSION = "1.5.0";

function env(name: string, fallback = ""): string {
  return (process.env[name] ?? fallback).trim();
}

function num(raw: string, fallback: number, min = 1): number {
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

function splitList(raw: string): string[] {
  return raw
    .split(",")
    .map((d) => d.trim())
    .filter(Boolean);
}

function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function readSystemsFile(file: string): SapSystem[] {
  try {
    if (!fs.existsSync(file)) return [];
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    if (Array.isArray(raw)) return raw as SapSystem[];
    if (raw && typeof raw === "object" && Array.isArray(raw.systems)) {
      return raw.systems as SapSystem[];
    }
    return [];
  } catch {
    return [];
  }
}

export function loadConfig(argv: string[] = process.argv.slice(2)): AppConfig {
  // CLI flags
  const has = (flag: string) => argv.includes(flag);
  const value = (flag: string, fb: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fb;
  };

  const httpMode = has("--http");
  const dataDir = expandHome(env("SAP_FIORI_MCP_DATA_DIR", path.join(os.homedir(), ".sap-fiori-mcp")));
  const logLevelRaw = env("LOG_LEVEL", env("SAP_FIORI_MCP_LOG_LEVEL", "error"));
  const logLevel = (["off", "error", "warn", "info", "debug"].includes(logLevelRaw)
    ? logLevelRaw
    : "error") as AppConfig["logLevel"];

  // SAP systems: from dedicated JSON env/file + from canonical single-system env vars
  const systems: SapSystem[] = [];
  const envJson = env("SAP_SYSTEMS_JSON");
  if (envJson) {
    try {
      const parsed = JSON.parse(envJson);
      if (Array.isArray(parsed)) systems.push(...parsed);
    } catch {
      /* invalid JSON ignored, file-based systems still loaded */
    }
  }
  systems.push(...readSystemsFile(env("SAP_SYSTEMS_FILE", path.join(dataDir, "systems.json"))));
  if (env("SAP_BASE_URL")) {
    const name = env("SAP_SYSTEM_NAME", "default");
    if (!systems.some((s) => s.name === name)) {
      systems.push({
        name,
        url: env("SAP_BASE_URL"),
        client: env("SAP_CLIENT") || undefined,
        user: env("SAP_USER") || undefined,
        password: env("SAP_PASSWORD") || undefined,
        authType: env("SAP_USER") ? "basic" : "none"
      });
    }
  }

  // Empty by default: the allowlist is opt-in, so out-of-the-box behaviour reaches any SAP host.
  const allowedDomains = splitList(env("SAP_FIORI_MCP_ALLOWED_DOMAINS"));
  const allowedOrigins = splitList(env("SAP_FIORI_MCP_ALLOWED_ORIGINS"));
  const toolPrefix = env("SAP_FIORI_MCP_TOOL_PREFIX").replace(/[^a-zA-Z0-9_]/g, "");

  return {
    serverName: SERVER_NAME,
    serverVersion: SERVER_VERSION,
    transport: httpMode ? "http" : "stdio",
    httpPort: num(value("--port", env("SAP_FIORI_MCP_PORT", "3001")), 3001),
    httpHost: value("--host", env("SAP_FIORI_MCP_HOST", "127.0.0.1")),
    apiKey: env("SAP_FIORI_MCP_API_KEY") || undefined,
    logLevel,
    logFile: expandHome(env("SAP_FIORI_MCP_LOG_FILE", path.join(dataDir, "server.log"))),
    dataDir,
    workspaceRoot: expandHome(env("SAP_FIORI_MCP_WORKSPACE_ROOT", process.cwd())),
    ui5CdnUrl: env("UI5_CDN_URL", env("UI5_MCP_SERVER_CDN_URL", "")) || "", // resolved per distribution in ui5 module
    ui5Distribution: env("UI5_DISTRIBUTION", "openui5").toLowerCase() === "sapui5" ? "sapui5" : "openui5",
    ui5TypesCdnUrl: env("UI5_TYPES_CDN_URL", "https://cdn.jsdelivr.net/npm/@openui5/ts-types-esm"),
    allowedDomains,
    allowedOrigins,
    toolPrefix,
    sapSystems: systems,
    requestTimeoutMs: num(env("SAP_FIORI_MCP_TIMEOUT_MS", "30000"), 30000, 1000),
    noResources: !!env("SAP_FIORI_MCP_RESPONSE_NO_RESOURCES")
  };
}
