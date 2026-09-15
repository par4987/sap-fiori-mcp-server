import type { AppConfig, SapSystem } from "../config.js";
import { logger } from "../logger.js";
import { assertUrlAllowed } from "../net/guard.js";
import { parseEdmx, type EdmxModel } from "./edmx.js";

export interface ODataRequestOptions {
  url: string;
  system?: SapSystem;
  timeoutMs?: number;
  accept?: string;
  method?: string;
  body?: string;
  headers?: Record<string, string>;
  csrf?: boolean;
  /** When given, the URL is checked against the outbound host allowlist before the request. */
  config?: AppConfig;
  /** Explicitly configured URLs (destination/system) that the allowlist must not block. */
  trustedUrls?: string[];
}

export interface ODataResponse {
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  text: string;
  json?: unknown;
}

function buildHeaders(opts: ODataRequestOptions): Record<string, string> {
  const headers: Record<string, string> = {
    accept: opts.accept ?? "application/json",
    ...(opts.system?.client ? { "sap-client": opts.system.client } : {}),
    ...opts.headers
  };
  if (opts.system?.user && opts.system?.password) {
    const token = Buffer.from(`${opts.system.user}:${opts.system.password}`).toString("base64");
    headers.authorization = `Basic ${token}`;
  } else if (opts.system?.user) {
    // allow password supplied via separate env var lookup at tool level
  }
  if (opts.body) headers["content-type"] = headers["content-type"] ?? "application/json";
  return headers;
}

/** Perform an OData request with timeout, auth and optional CSRF token handshake. */
export async function odataRequest(opts: ODataRequestOptions): Promise<ODataResponse> {
  if (opts.config) assertUrlAllowed(opts.config, opts.url, [...(opts.trustedUrls ?? []), ...(opts.system ? [opts.system.url] : [])]);
  const headers = buildHeaders(opts);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30000);
  try {
    let csrfToken: string | null = null;
    if (opts.csrf) {
      const probe = await fetch(opts.url, { method: "HEAD", headers: { ...headers, "x-csrf-token": "fetch" }, signal: controller.signal });
      csrfToken = probe.headers.get("x-csrf-token");
      if (csrfToken) headers["x-csrf-token"] = csrfToken;
    }
    const res = await fetch(opts.url, {
      method: opts.method ?? "GET",
      headers,
      body: opts.body,
      signal: controller.signal,
      redirect: "follow"
    });
    const responseHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => (responseHeaders[k] = v));
    const text = await res.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: res.status, ok: res.ok, headers: responseHeaders, text, json };
  } catch (error) {
    logger.error("odataRequest failed", { url: opts.url, error });
    throw error instanceof Error ? error : new Error(String(error));
  } finally {
    clearTimeout(timer);
  }
}

export function appendSearchParams(url: string, params: Record<string, string | undefined>): string {
  const u = new URL(url);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") u.searchParams.set(k, v);
  }
  return u.toString();
}

/** Detect whether a base service URL is OData V2 or V4 by fetching metadata. */
export async function fetchServiceMetadata(
  url: string,
  system?: SapSystem,
  timeoutMs?: number,
  headers?: Record<string, string>,
  config?: AppConfig,
  trustedUrls?: string[]
): Promise<{ xml: string; model: EdmxModel; sourceUrl: string }> {
  if (!url) throw new Error("No service URL resolved. Provide serviceUrl, systemName (+servicePath) or destination (+servicePath).");
  const base = url.replace(/\/$/, "");
  // the sap-client variant is only worth a second round trip when a client is actually configured
  const candidates = [`${base}/$metadata`, ...(system?.client ? [`${base}/$metadata?sap-client=${system.client}`] : [])];
  const unique = [...new Set(candidates)];
  let lastError: Error | null = null;
  for (const candidate of unique) {
    try {
      const res = await odataRequest({ url: candidate, system, timeoutMs, accept: "application/xml", headers, config, trustedUrls });
      if (res.ok && res.text.includes("<edmx")) {
        return { xml: res.text, model: parseEdmx(res.text), sourceUrl: candidate };
      }
      lastError = new Error(isNotOData(res) ? notODataMessage(candidate, res) : `Metadata request to ${candidate} returned HTTP ${res.status}`);
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
    }
  }
  throw lastError ?? new Error(`Unable to fetch metadata from ${base}`);
}

/** Query an entity set with OData system query options ($filter/$top/$skip/$select/$count). */

/** Resolve a system by name from config; "default" also falls back to canonical env vars. */
export function resolveSystem(config: AppConfig, name?: string): SapSystem | undefined {
  if (!name) {
    return config.sapSystems.find((s) => s.name === "default") ?? config.sapSystems[0];
  }
  return config.sapSystems.find((s) => s.name.toLowerCase() === name.toLowerCase());
}

/**
 * An OData endpoint that answers HTML is not answering OData.
 *
 * A BTP or Fiori endpoint reached without an accepted session replies 200 with a login page, and
 * the row extractor finds neither `value` nor `d` in it — so an unauthenticated call used to look
 * exactly like a query that matched nothing. Reporting zero rows for a refused request is the
 * worst of both: no error to investigate, and an answer that is wrong.
 */
export function isNotOData(res: ODataResponse): boolean {
  return (res.headers["content-type"] ?? "").toLowerCase().includes("text/html");
}

/** What to tell the caller when an endpoint answered with a page instead of data. */
export function notODataMessage(url: string, res: ODataResponse): string {
  const login = /fragmentAfterLogin|saml|j_username|logon|Anmeldung/i.test(res.text);
  return (
    `${url} answered HTTP ${res.status} with HTML instead of OData` +
    (login
      ? ": that is a login page, so the request was not authenticated. A token that the service does not accept looks exactly like this."
      : ", so this path is probably not an OData service.")
  );
}

/** V4 reports the total as a number, V2 as a string. */
function countOf(raw: unknown): number | undefined {
  if (typeof raw === "number") return raw;
  if (typeof raw === "string") {
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/** Extract rows from OData JSON response for V2 (d.results / d array) and V4 (value). */
export function extractRows(json: unknown): { rows: unknown[]; inlineCount?: number } {
  const obj = json as Record<string, unknown> | undefined;
  if (!obj) return { rows: [] };
  if (Array.isArray(obj.value)) return { rows: obj.value, inlineCount: countOf(obj["@odata.count"]) };
  // V2 shapes seen in the wild: { d: { results: [...] } }, { d: [...] } (some services do this
  // once $expand/$select are involved) and { d: {...} } for a single entity.
  const d = obj.d as Record<string, unknown> | unknown[] | undefined;
  if (Array.isArray(d)) return { rows: d };
  if (d) {
    const wrapper = d as Record<string, unknown>;
    if (Array.isArray(wrapper.results)) {
      return { rows: wrapper.results, inlineCount: countOf(wrapper.__count) };
    }
    return { rows: [wrapper] };
  }
  return { rows: [] };
}
