import fs from "node:fs";
import path from "node:path";
import type { AppConfig } from "./config.js";

type Level = "off" | "error" | "warn" | "info" | "debug";

const LEVELS: Record<Level, number> = { off: 0, error: 1, warn: 2, info: 3, debug: 4 };

let currentLevel: number = LEVELS.error;
let logFile: string | null = null;

export function initLogger(config: Pick<AppConfig, "logLevel" | "logFile">): void {
  currentLevel = LEVELS[config.logLevel] ?? LEVELS.error;
  logFile = config.logFile;
  if (currentLevel > 0 && logFile) {
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
    } catch {
      logFile = null;
    }
  }
}

function write(level: Level, msg: string, meta?: unknown): void {
  if (LEVELS[level] === 0 || LEVELS[level] > currentLevel) return;
  const entry = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg,
    ...(meta !== undefined ? { meta: meta instanceof Error ? { name: meta.name, message: meta.message, stack: meta.stack } : meta } : {})
  });
  // Never stdout in stdio mode: corrupts MCP framing. File only (stderr is safe but noisy).
  if (logFile) {
    try {
      fs.appendFileSync(logFile, entry + "\n");
    } catch {
      /* swallow */
    }
  }
}

export const logger = {
  error: (msg: string, meta?: unknown) => write("error", msg, meta),
  warn: (msg: string, meta?: unknown) => write("warn", msg, meta),
  info: (msg: string, meta?: unknown) => write("info", msg, meta),
  debug: (msg: string, meta?: unknown) => write("debug", msg, meta)
};
