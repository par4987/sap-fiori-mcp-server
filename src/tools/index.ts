import type { z } from "zod";
import { logger } from "../logger.js";

export interface ToolResult {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  /** The SDK's CallToolResult allows extra top-level fields (`_meta`, …). */
  [key: string]: unknown;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Successful tool response.
 *
 * Returns the payload twice on purpose: as `structuredContent` for clients that consume the
 * declared `outputSchema`, and as a JSON text block for clients that only read text
 * (the MCP spec asks servers to keep the text form for backwards compatibility).
 */
export function json(data: unknown, isError = false): ToolResult {
  const result: ToolResult = { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  // structuredContent is validated against outputSchema, and only for non-error results
  if (!isError && isPlainObject(data)) result.structuredContent = data;
  if (isError) result.isError = true;
  return result;
}

/** Failed tool call. Reported inside the result (never thrown at the transport). */
export function err(e: unknown): ToolResult {
  const message = e instanceof Error ? e.message : String(e);
  logger.error("tool error", { message, stack: e instanceof Error ? e.stack : undefined });
  return {
    content: [{ type: "text", text: JSON.stringify({ error: message }, null, 2) }],
    isError: true
  };
}

export interface Page<T> {
  /** Items in this page. */
  items: T[];
  /** Number of items in this page. */
  count: number;
  /** Total number of items matching the request. */
  total: number;
  offset: number;
  hasMore: boolean;
  /** Offset to pass in the next call, or null when the last page was returned. */
  nextOffset: number | null;
}

/** Slice a result set and return the pagination metadata MCP clients need to continue. */
export function paginate<T>(items: T[], limit: number, offset = 0): Page<T> {
  const start = Math.max(0, offset);
  const page = items.slice(start, start + limit);
  const hasMore = start + page.length < items.length;
  return {
    items: page,
    count: page.length,
    total: items.length,
    offset: start,
    hasMore,
    nextOffset: hasMore ? start + page.length : null
  };
}

/**
 * Tool annotations (hints, not guarantees — see the MCP spec).
 *
 * `openWorldHint` is true whenever the tool talks to something outside this machine,
 * which is what separates the local-filesystem tools from the OData/CDN ones.
 */
export const READ_LOCAL = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
export const READ_REMOTE = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;
/** Creates new files; refuses to overwrite an existing target, so it is not destructive. */
export const WRITE_CREATE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
/** Writes into an existing project and can overwrite or delete files. */
export const WRITE_MODIFY = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } as const;
/** Writes a file locally with content fetched from a remote service. */
export const WRITE_REMOTE = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true } as const;

export type ToolArgs = Record<string, unknown>;
export type { z };
