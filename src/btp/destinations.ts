/**
 * SAP BTP destination support.
 *
 * Resolves destinations from three sources (in this order):
 *   1. Inline JSON env var  SAP_DESTINATIONS_JSON  (array of destination objects)
 *      — also accepts the SAP Cloud SDK style lowercase `destinations` env var.
 *   2. JSON file / directory:
 *        SAP_DESTINATIONS_FILE  → single JSON file (array or { destinations: [...] })
 *        SAP_DESTINATIONS_DIR   → one <name>.json file per destination
 *      (default dir: <dataDir>/destinations, i.e. ~/.sap-fiori-mcp/destinations)
 *   3. BTP Destination Service (cloud):
 *        explicit env vars  BTP_CLIENT_ID / BTP_CLIENT_SECRET / BTP_TOKEN_URL / BTP_DESTINATION_API_URL
 *        or a VCAP_SERVICES binding containing a `destination` and an `xsuaa` service.
 *
 * Destination objects accept both the SAP cockpit export format (Title case keys:
 * Name, URL, Authentication, User, Password, clientId, clientSecret, tokenServiceURL,
 * sap-client, ProxyType, WebIDEEnabled, ...) and a friendlier camelCase format
 * (name, url, authType, username, password, client, tokenServiceUrl, headers...).
 */
import fs from "node:fs";
import path from "node:path";
import type { AppConfig, SapSystem } from "../config.js";
import { logger } from "../logger.js";
import { stripBom } from "../util/fs.js";
import { expandEnvRefsDeep } from "../util/envref.js";
import { readServiceKeyFile } from "./service-key.js";
import { readRefreshToken } from "./token-store.js";
import { resolveSystem } from "../odata/client.js";

export type DestinationAuthType =
  | "NoAuthentication"
  | "BasicAuthentication"
  | "OAuth2ClientCredentials"
  | "OAuth2Password"
  | "OAuth2RefreshToken"
  | "OAuth2UserTokenExchange"
  | "OAuth2JWTBearer"
  | "ClientCertificateAuthentication"
  | "SAMLAssertion";

export type DestinationSource = "env" | "file" | "destination-service";

export interface BtpDestination {
  name: string;
  url: string;
  authType: DestinationAuthType;
  proxyType?: string;
  username?: string;
  password?: string;
  client?: string;
  clientId?: string;
  clientSecret?: string;
  tokenServiceUrl?: string;
  tokenServiceUser?: string;
  tokenServicePassword?: string;
  userToken?: string;
  /** Long-lived token from a one-time browser login, for the refresh_token grant. */
  refreshToken?: string;
  headers?: Record<string, string>;
  /** Service key file this destination took its OAuth credentials from, when it used one. */
  serviceKeyPath?: string;
  source: DestinationSource;
}

export interface DestinationServiceConfig {
  apiUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
}

const AUTH_TYPES: DestinationAuthType[] = [
  "NoAuthentication",
  "BasicAuthentication",
  "OAuth2ClientCredentials",
  "OAuth2Password",
  "OAuth2RefreshToken",
  "OAuth2UserTokenExchange",
  "OAuth2JWTBearer",
  "ClientCertificateAuthentication",
  "SAMLAssertion"
];

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "";
}

function pick(raw: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = str(raw[k]);
    if (v) return v;
  }
  return "";
}

/** Normalize a raw destination object (cockpit format or camelCase) into BtpDestination. */
export function normalizeDestination(raw: Record<string, unknown>, source: DestinationSource, fallbackName?: string): BtpDestination {
  const name = pick(raw, ["Name", "name", "DestinationName", "destinationName"]) || fallbackName || "unnamed";
  const authRaw = pick(raw, ["Authentication", "authentication", "authType", "Type", "type"]);
  const authType = (AUTH_TYPES.find((a) => a.toLowerCase() === authRaw.toLowerCase()) ??
    (authRaw.toLowerCase() === "basic" ? "BasicAuthentication" : authRaw.toLowerCase() === "none" || !authRaw ? "NoAuthentication" : authRaw)) as DestinationAuthType;
  const customHeaders: Record<string, string> = {};
  const headersRaw = raw.headers ?? raw.Headers ?? raw.URLHeaders ?? raw.urlHeaders;
  if (headersRaw && typeof headersRaw === "object" && !Array.isArray(headersRaw)) {
    for (const [k, v] of Object.entries(headersRaw as Record<string, unknown>)) {
      if (typeof v === "string" || typeof v === "number") customHeaders[k] = String(v);
    }
  }
  // A service key answers every OAuth question at once, so it wins over hand-typed fields and
  // keeps the client secret in the key file instead of in this destination.
  const serviceKeyPath = pick(raw, ["serviceKeyPath", "ServiceKeyPath", "serviceKeyFile", "servicekeypath"]);
  let fromKey: { clientId?: string; clientSecret?: string; tokenServiceUrl?: string; url?: string } = {};
  if (serviceKeyPath) {
    try {
      const key = readServiceKeyFile(serviceKeyPath);
      // the host the key names is the one that serves the APIs; its -web twin only answers
      // browsers, and answers them with a login page rather than an error
      fromKey = { clientId: key.clientId, clientSecret: key.clientSecret, tokenServiceUrl: key.tokenUrl, url: key.endpointUrl };
    } catch (e) {
      logger.warn("destination service key could not be read", { name, serviceKeyPath, error: String(e) });
    }
  }

  return {
    name,
    url: pick(raw, ["URL", "url", "Uri", "uri"]) || fromKey.url || "",
    authType,
    proxyType: pick(raw, ["ProxyType", "proxyType"]) || undefined,
    username: pick(raw, ["User", "user", "username", "Username"]) || undefined,
    password: pick(raw, ["Password", "password"]) || undefined,
    client: pick(raw, ["sap-client", "client", "SAPClient"]) || undefined,
    clientId: fromKey.clientId || pick(raw, ["clientId", "clientid", "ClientID"]) || undefined,
    clientSecret: fromKey.clientSecret || pick(raw, ["clientSecret", "clientsecret", "ClientSecret"]) || undefined,
    tokenServiceUrl: fromKey.tokenServiceUrl || pick(raw, ["tokenServiceURL", "tokenServiceUrl", "token_service_url", "tokenUrl"]) || undefined,
    tokenServiceUser: pick(raw, ["tokenServiceUser", "tokenServiceUsername"]) || undefined,
    tokenServicePassword: pick(raw, ["tokenServicePassword", "tokenServiceUserPassword"]) || undefined,
    userToken: pick(raw, ["userToken", "user_token", "bearerToken"]) || process.env.BTP_USER_TOKEN?.trim() || undefined,
    refreshToken: pick(raw, ["refreshToken", "refresh_token", "RefreshToken"]) || process.env.BTP_REFRESH_TOKEN?.trim() || undefined,
    headers: Object.keys(customHeaders).length ? customHeaders : undefined,
    serviceKeyPath: serviceKeyPath || undefined,
    source
  };
}

function readDestinationsFromJson(jsonText: string, source: DestinationSource, fallbackName?: string): BtpDestination[] {
  // destinations carry client secrets, so they benefit from ${env:NAME} the most
  const parsed = expandEnvRefsDeep(JSON.parse(stripBom(jsonText))) as unknown;
  if (Array.isArray(parsed)) return parsed.filter((d) => d && typeof d === "object").map((d) => normalizeDestination(d as Record<string, unknown>, source, fallbackName));
  if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    if (Array.isArray(obj.destinations)) return obj.destinations.map((d) => normalizeDestination(d as Record<string, unknown>, source, fallbackName));
    return [normalizeDestination(obj, source, fallbackName)];
  }
  return [];
}

/** Load destinations from inline env vars + file/dir sources. Never throws (bad entries are logged and skipped). */
export function loadDestinations(config: Pick<AppConfig, "dataDir">): BtpDestination[] {
  const out: BtpDestination[] = [];
  const pushMany = (list: BtpDestination[]) => {
    for (const d of list) {
      if (out.some((x) => x.name.toLowerCase() === d.name.toLowerCase())) continue; // first source wins
      out.push(d);
    }
  };

  // 1) inline env JSON
  const envJson = process.env.SAP_DESTINATIONS_JSON?.trim();
  if (envJson) {
    try {
      pushMany(readDestinationsFromJson(envJson, "env"));
    } catch (e) {
      logger.warn("SAP_DESTINATIONS_JSON is not valid JSON", { error: String(e) });
    }
  }
  // 1b) SAP Cloud SDK style lowercase `destinations` env var
  const sdkJson = process.env.destinations?.trim();
  if (sdkJson) {
    try {
      pushMany(readDestinationsFromJson(sdkJson, "env"));
    } catch (e) {
      logger.warn("env var `destinations` is not valid JSON", { error: String(e) });
    }
  }

  // 2) single JSON file
  const file = process.env.SAP_DESTINATIONS_FILE?.trim();
  if (file) {
    try {
      if (fs.existsSync(file)) pushMany(readDestinationsFromJson(fs.readFileSync(file, "utf8"), "file"));
      else logger.warn("SAP_DESTINATIONS_FILE does not exist", { file });
    } catch (e) {
      logger.warn("Failed to read SAP_DESTINATIONS_FILE", { file, error: String(e) });
    }
  }

  // 3) directory with one <name>.json per destination
  const dir = process.env.SAP_DESTINATIONS_DIR?.trim() || path.join(config.dataDir, "destinations");
  try {
    if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
      for (const entry of fs.readdirSync(dir).sort()) {
        if (!entry.toLowerCase().endsWith(".json")) continue;
        const full = path.join(dir, entry);
        try {
          const list = readDestinationsFromJson(fs.readFileSync(full, "utf8"), "file", path.basename(entry, ".json"));
          pushMany(list);
        } catch (e) {
          logger.warn("Invalid destination file skipped", { file: full, error: String(e) });
        }
      }
    }
  } catch (e) {
    logger.warn("Failed to scan destinations dir", { dir, error: String(e) });
  }

  return out;
}

export function redactDestination(d: BtpDestination): Record<string, unknown> {
  const REDACTED = "«redacted»";
  return {
    name: d.name,
    url: d.url,
    authType: d.authType,
    proxyType: d.proxyType ?? "Internet",
    sapClient: d.client,
    username: d.username,
    password: d.password ? REDACTED : undefined,
    clientId: d.clientId,
    clientSecret: d.clientSecret ? REDACTED : undefined,
    tokenServiceUrl: d.tokenServiceUrl,
    tokenServiceUser: d.tokenServiceUser,
    tokenServicePassword: d.tokenServicePassword ? REDACTED : undefined,
    userToken: d.userToken ? REDACTED : undefined,
    refreshToken: d.refreshToken ? REDACTED : undefined,
    customHeaders: d.headers ? Object.keys(d.headers) : [],
    serviceKeyPath: d.serviceKeyPath,
    source: d.source
  };
}

// ---------------------------------------------------------------------------
// Destination Service (cloud)
// ---------------------------------------------------------------------------

/** Resolve the BTP Destination Service config from env vars or VCAP_SERVICES. Returns null when absent. */
export function getDestinationServiceConfig(): DestinationServiceConfig | null {
  // The whole key in one variable beats four variables the operator has to split by hand.
  const keyFile = process.env.BTP_SERVICE_KEY_FILE?.trim();
  if (keyFile) {
    try {
      const key = readServiceKeyFile(keyFile);
      if (key.apiUrl) return { apiUrl: key.apiUrl, tokenUrl: key.tokenUrl, clientId: key.clientId, clientSecret: key.clientSecret };
      logger.warn("BTP_SERVICE_KEY_FILE is not a destination service key (no 'uri' field)", { keyFile, kind: key.kind });
    } catch (e) {
      logger.warn("BTP_SERVICE_KEY_FILE could not be read", { keyFile, error: String(e) });
    }
  }

  const apiUrl = process.env.BTP_DESTINATION_API_URL?.trim();
  const tokenUrl = process.env.BTP_TOKEN_URL?.trim();
  const clientId = process.env.BTP_CLIENT_ID?.trim();
  const clientSecret = process.env.BTP_CLIENT_SECRET?.trim();
  if (apiUrl && tokenUrl && clientId && clientSecret) {
    return { apiUrl: apiUrl.replace(/\/$/, ""), tokenUrl: tokenUrl.replace(/\/$/, ""), clientId, clientSecret };
  }

  const vcapRaw = process.env.VCAP_SERVICES?.trim();
  if (!vcapRaw) return null;
  try {
    const vcap = JSON.parse(vcapRaw) as Record<string, Array<{ name?: string; label?: string; credentials?: Record<string, unknown> }>>;
    let uri = "";
    let xsuaa: Record<string, unknown> | null = null;
    for (const [service, bindings] of Object.entries(vcap)) {
      if (!Array.isArray(bindings)) continue;
      for (const b of bindings) {
        const label = `${service} ${b.label ?? ""}`.toLowerCase();
        const creds = b.credentials;
        if (!creds) continue;
        if (/destination/.test(label) && (str(creds.uri) || str(creds.url))) uri = str(creds.uri) || str(creds.url);
        if (/xsuaa|identity/.test(label) && str(creds.clientid) && str(creds.clientsecret)) {
          xsuaa = creds;
        }
      }
    }
    if (uri && xsuaa) {
      const tokenUrlVcap = str(xsuaa.url);
      const clientIdVcap = str(xsuaa.clientid);
      const clientSecretVcap = str(xsuaa.clientsecret);
      if (tokenUrlVcap && clientIdVcap && clientSecretVcap) {
        return { apiUrl: uri.replace(/\/$/, ""), tokenUrl: tokenUrlVcap.replace(/\/$/, ""), clientId: clientIdVcap, clientSecret: clientSecretVcap };
      }
    }
  } catch (e) {
    logger.warn("VCAP_SERVICES is not valid JSON", { error: String(e) });
  }
  return null;
}

/**
 * What the UAA said, rather than only the status code it said it with.
 *
 * A 401 from the token endpoint has several unrelated causes — a wrong client secret, a revoked
 * client, an expired refresh token — and they need different fixes. The body names which one it is,
 * and dropping it turned an expired token into what looked like a broken service key. Only the
 * error fields are read: the response is never echoed wholesale, so nothing secret rides along.
 */
async function tokenErrorDetail(res: Response): Promise<string> {
  try {
    const parsed = JSON.parse(await res.text()) as { error?: string; error_description?: string };
    return parsed.error_description ?? parsed.error ?? "";
  } catch {
    return "";
  }
}

async function fetchXsuaaToken(svc: DestinationServiceConfig, timeoutMs: number): Promise<string> {
  const url = `${svc.tokenUrl}/oauth/token?grant_type=client_credentials`;
  const auth = Buffer.from(`${svc.clientId}:${svc.clientSecret}`).toString("base64");
  const res = await fetch(url, {
    method: "POST",
    headers: { authorization: `Basic ${auth}`, accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!res.ok) {
    const detail = await tokenErrorDetail(res);
    throw new Error(`XSUAA token request failed (HTTP ${res.status})${detail ? `: ${detail}` : ""}`);
  }
  const body = (await res.json()) as { access_token?: string };
  if (!body.access_token) throw new Error("XSUAA token response contains no access_token");
  return body.access_token;
}

interface ServiceDestinationResponse {
  destinationConfiguration?: Record<string, unknown>;
  authTokens?: Array<{ type?: string; value?: string; http_header?: { Authorization?: string } }>;
  Name?: string;
  name?: string;
}

/** Fetch a single destination from the BTP Destination Service (instance level, then subaccount level). */
export async function fetchServiceDestination(svc: DestinationServiceConfig, name: string, timeoutMs: number): Promise<BtpDestination | null> {
  const token = await fetchXsuaaToken(svc, timeoutMs);
  const endpoints = [
    `${svc.apiUrl}/destination-configuration/v1/destinations/${encodeURIComponent(name)}`,
    `${svc.apiUrl}/destination-configuration/v1/subaccountDestinations/${encodeURIComponent(name)}`
  ];
  for (const endpoint of endpoints) {
    const res = await fetch(endpoint, { headers: { authorization: `Bearer ${token}`, accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
    if (res.status === 404) continue;
    if (!res.ok) throw new Error(`Destination Service request failed (HTTP ${res.status}) for ${endpoint}`);
    const body = (await res.json()) as ServiceDestinationResponse;
    const cfg = body.destinationConfiguration ?? {};
    const dest = normalizeDestination(cfg, "destination-service", name);
    dest.name = str(cfg.Name) || name;
    // Pre-exchanged token from the destination service: use it verbatim as Authorization header
    const authToken = body.authTokens?.[0];
    if (authToken) {
      const headerValue = authToken.http_header?.Authorization ?? (authToken.type?.toLowerCase() === "bearer" ? `Bearer ${authToken.value}` : authToken.value);
      if (headerValue) {
        dest.headers = { ...(dest.headers ?? {}), authorization: headerValue };
      }
    }
    return dest;
  }
  return null;
}

/** List destinations from the BTP Destination Service (instance + subaccount). */
export async function listServiceDestinations(svc: DestinationServiceConfig, timeoutMs: number): Promise<BtpDestination[]> {
  const token = await fetchXsuaaToken(svc, timeoutMs);
  const endpoints = [`${svc.apiUrl}/destination-configuration/v1/destinations`, `${svc.apiUrl}/destination-configuration/v1/subaccountDestinations`];
  const out: BtpDestination[] = [];
  for (const ep of endpoints) {
    try {
      const res = await fetch(ep, { headers: { authorization: `Bearer ${token}`, accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) continue;
      const body = (await res.json()) as unknown;
      if (!Array.isArray(body)) continue;
      for (const raw of body as ServiceDestinationResponse[]) {
        const cfg = (raw.destinationConfiguration ?? raw) as Record<string, unknown>;
        const d = normalizeDestination(cfg, "destination-service");
        d.name = str(cfg.Name) || str(raw.Name) || str(raw.name) || d.name;
        out.push(d);
      }
    } catch (e) {
      logger.warn("Failed to list destinations from service", { endpoint: ep, error: String(e) });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Authentication headers
// ---------------------------------------------------------------------------

async function fetchOAuthToken(d: BtpDestination, params: Record<string, string>, timeoutMs: number, basicUser?: string, basicPassword?: string): Promise<string> {
  const tokenUrl = d.tokenServiceUrl;
  if (!tokenUrl) throw new Error(`Destination '${d.name}': tokenServiceURL is required for ${d.authType}`);
  const headers: Record<string, string> = { accept: "application/json", "content-type": "application/x-www-form-urlencoded" };
  if (basicUser && basicPassword) headers.authorization = `Basic ${Buffer.from(`${basicUser}:${basicPassword}`).toString("base64")}`;
  const body = new URLSearchParams(params).toString();
  const res = await fetch(`${tokenUrl.replace(/\/$/, "")}/oauth/token`, { method: "POST", headers, body, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) {
    const detail = await tokenErrorDetail(res);
    // an expired refresh token is the one cause with a fix the caller can act on, and the panel
    // was the only place that ever said so
    const fix =
      params.grant_type === "refresh_token"
        ? ` Call the btp_login tool with destination '${d.name}' to sign in again, or run 'sap-fiori-mcp --btp-login --destination ${d.name}' in a terminal.`
        : "";
    throw new Error(`Destination '${d.name}': OAuth token request failed (HTTP ${res.status})${detail ? `: ${detail}` : ""}${fix}`);
  }
  const json = (await res.json()) as { access_token?: string };
  if (!json.access_token) throw new Error(`Destination '${d.name}': token response contains no access_token`);
  return json.access_token;
}

/** Build the HTTP headers to call the destination URL (async: may exchange an OAuth token). */
export async function buildAuthHeaders(d: BtpDestination, timeoutMs = 30000, dataDir?: string): Promise<Record<string, string>> {
  const headers: Record<string, string> = {};
  if (d.client) headers["sap-client"] = d.client;
  if (d.headers) Object.assign(headers, d.headers);
  if (headers.authorization) return headers; // pre-exchanged (destination service) or explicit header

  switch (d.authType) {
    case "BasicAuthentication":
      if (d.username && d.password) headers.authorization = `Basic ${Buffer.from(`${d.username}:${d.password}`).toString("base64")}`;
      else if (d.username) logger.warn("Destination has username but no password", { name: d.name });
      break;
    /**
     * What a BTP ABAP Environment on a trial subaccount actually needs.
     *
     * The identity provider owns the user, so there is no password to send to the UAA: the
     * operator logs in through a browser once, and the refresh token that comes back stands in
     * for them from then on. The service key's client authenticates the exchange.
     */
    case "OAuth2RefreshToken": {
      // an explicit ${env:...} still wins; the store is the default so nobody has to copy a
      // token this tool minted itself
      if (!d.refreshToken && dataDir) d.refreshToken = readRefreshToken(dataDir, d.name) ?? undefined;
      if (!d.refreshToken) {
        throw new Error(
          `Destination '${d.name}': the refresh_token grant needs a token from a one-time browser login. ` +
            `Call the btp_login tool with destination '${d.name}', or run --btp-login in a terminal, or set refreshToken on the destination as \${env:NAME}.`
        );
      }
      if (!d.clientId || !d.clientSecret) {
        throw new Error(`Destination '${d.name}': the refresh_token grant needs the OAuth client, normally supplied by serviceKeyPath.`);
      }
      const token = await fetchOAuthToken(
        d,
        { grant_type: "refresh_token", refresh_token: d.refreshToken },
        timeoutMs,
        d.clientId,
        d.clientSecret
      );
      headers.authorization = `Bearer ${token}`;
      break;
    }
    /**
     * For a subaccount whose users live in the UAA itself.
     *
     * Client credentials buy a token that belongs to the OAuth client and to no person, which an
     * ABAP system answers 401 to because it has nobody to run as — so a named user is needed
     * either way. This grant supplies one directly, but only works where the UAA holds the
     * password. A trial subaccount delegates to an identity provider and has none, and there
     * OAuth2RefreshToken is the grant that applies.
     */
    case "OAuth2Password": {
      if (!d.username || !d.password) {
        throw new Error(
          `Destination '${d.name}': the password grant needs a BTP user and password. Set User and Password on the destination ` +
            "(the password as ${env:NAME}); the client id and secret come from the service key."
        );
      }
      if (!d.clientId || !d.clientSecret) {
        throw new Error(`Destination '${d.name}': the password grant needs the OAuth client, normally supplied by serviceKeyPath.`);
      }
      const token = await fetchOAuthToken(
        d,
        { grant_type: "password", username: d.username, password: d.password, response_type: "token" },
        timeoutMs,
        d.clientId,
        d.clientSecret
      );
      headers.authorization = `Bearer ${token}`;
      break;
    }
    case "OAuth2ClientCredentials": {
      const useCreds = !!(d.clientId && d.clientSecret);
      const token = await fetchOAuthToken(d, { grant_type: "client_credentials" }, timeoutMs, useCreds ? d.clientId : d.tokenServiceUser, useCreds ? d.clientSecret : d.tokenServicePassword);
      headers.authorization = `Bearer ${token}`;
      break;
    }
    case "OAuth2UserTokenExchange": {
      if (!d.userToken) throw new Error(`Destination '${d.name}': OAuth2UserTokenExchange requires a user token (set 'userToken' in the destination or BTP_USER_TOKEN env var)`);
      const token = await fetchOAuthToken(d, { grant_type: "user_token", token: d.userToken }, timeoutMs, d.clientId, d.clientSecret);
      headers.authorization = `Bearer ${token}`;
      break;
    }
    case "OAuth2JWTBearer": {
      if (!d.userToken) throw new Error(`Destination '${d.name}': OAuth2JWTBearer requires the user JWT (set 'userToken' in the destination or BTP_USER_TOKEN env var)`);
      const token = await fetchOAuthToken(d, { grant_type: "jwt_bearer", assertion: d.userToken }, timeoutMs, d.clientId, d.clientSecret);
      headers.authorization = `Bearer ${token}`;
      break;
    }
    case "ClientCertificateAuthentication":
      throw new Error(`Destination '${d.name}': ClientCertificateAuthentication is not supported by this server. Use the BTP Destination Service (which exchanges tokens for you) or a BasicAuthentication destination.`);
    case "SAMLAssertion":
      throw new Error(`Destination '${d.name}': SAMLAssertion is not supported by this server. Use the BTP Destination Service or a BasicAuthentication destination.`);
    case "NoAuthentication":
    default:
      break;
  }
  return headers;
}

// ---------------------------------------------------------------------------
// Resolution: destination | system | url
// ---------------------------------------------------------------------------

export interface ODataTarget {
  url: string;
  headers: Record<string, string>;
  system?: SapSystem;
  source: string;
  destination?: Record<string, unknown>;
  /**
   * URLs the user configured explicitly (a destination, a system). They bypass the outbound
   * host allowlist, which exists to constrain URLs that arrive as tool arguments.
   */
  trustedUrls: string[];
}

function joinUrl(base: string, servicePath: string): string {
  if (!servicePath) return base;
  return `${base.replace(/\/$/, "")}/${servicePath.replace(/^\//, "")}`;
}

/**
 * Resolve the URL + auth for an OData call from (destination | systemName+servicePath | serviceUrl).
 * Priority: destination → systemName → plain serviceUrl.
 */
export async function resolveODataTarget(
  config: AppConfig,
  p: { destination?: string; systemName?: string; serviceUrl?: string; servicePath?: string },
  timeoutMs = 30000
): Promise<ODataTarget> {
  // 1) BTP destination
  if (p.destination) {
    const local = loadDestinations(config).find((d) => d.name.toLowerCase() === p.destination!.toLowerCase());
    const svc = local ? null : getDestinationServiceConfig();
    const d = local ?? (svc ? await fetchServiceDestination(svc, p.destination, timeoutMs) : null);
    if (!d) {
      const available = loadDestinations(config).map((x) => x.name);
      throw new Error(
        `Destination '${p.destination}' not found. Available local destinations: ${available.length ? available.join(", ") : "(none)"}` +
          (getDestinationServiceConfig() ? "" : ". The BTP Destination Service is not configured (set BTP_CLIENT_ID, BTP_CLIENT_SECRET, BTP_TOKEN_URL, BTP_DESTINATION_API_URL or VCAP_SERVICES).")
      );
    }
    const base = p.serviceUrl ?? (p.servicePath ? joinUrl(d.url, p.servicePath) : d.url);
    if (!base) throw new Error(`Destination '${d.name}' has no URL and no servicePath/serviceUrl was provided.`);
    const headers = await buildAuthHeaders(d, timeoutMs, config.dataDir);
    return { url: base, headers, source: `destination:${d.name}`, destination: redactDestination(d), trustedUrls: [d.url] };
  }

  // 2) configured SAP system (list_sap_systems)
  const system = resolveSystem(config, p.systemName);
  if (p.systemName && !system) {
    const known = config.sapSystems.map((s) => s.name);
    throw new Error(
      `SAP system '${p.systemName}' is not configured. Known systems: ${known.length ? known.join(", ") : "(none)"}. ` +
        "Run list_sap_systems, or set SAP_BASE_URL / SAP_SYSTEMS_JSON / ~/.sap-fiori-mcp/systems.json."
    );
  }
  if (system && (p.servicePath || !p.serviceUrl)) {
    const url = p.serviceUrl ? p.serviceUrl : joinUrl(system.url, p.servicePath ?? "");
    return { url, headers: {}, system, source: `system:${system.name}`, trustedUrls: [system.url] };
  }

  // 3) plain URL
  if (p.serviceUrl) return { url: p.serviceUrl, headers: {}, source: "url", trustedUrls: [] };

  throw new Error("Provide a BTP destination name, a systemName (+servicePath) from list_sap_systems, or a full serviceUrl. Run list_btp_destinations / list_sap_systems first.");
}

/**
 * The URL a destination or system would be called on, without authenticating.
 *
 * Composing a URL to write into a manifest should not cost an OAuth round trip: the token buys
 * nothing here, and a service key that is momentarily unreachable would stop an app from being
 * generated for no reason. Returns null when nothing names a target.
 */
export function resolveODataUrl(config: AppConfig, p: { destination?: string; systemName?: string; servicePath?: string }): string | null {
  // Nothing named means nothing to resolve. resolveSystem falls back to the first configured
  // system when asked for no name in particular, which is a helpful default for a query the
  // caller aimed somewhere — and a wrong answer when composing a URL out of thin air.
  if (!p.destination && !p.systemName && !p.servicePath) return null;
  const base = p.destination
    ? loadDestinations(config).find((d) => d.name.toLowerCase() === p.destination!.toLowerCase())?.url
    : resolveSystem(config, p.systemName)?.url;
  if (!base) return null;
  const url = p.servicePath ? joinUrl(base, p.servicePath) : base;
  return url.endsWith("/") ? url : `${url}/`;
}

/** Find a destination by name across local sources and the destination service. */
export async function findDestination(config: AppConfig, name: string, timeoutMs = 30000): Promise<BtpDestination | null> {
  const local = loadDestinations(config).find((d) => d.name.toLowerCase() === name.toLowerCase());
  if (local) return local;
  const svc = getDestinationServiceConfig();
  if (!svc) return null;
  return fetchServiceDestination(svc, name, timeoutMs);
}
