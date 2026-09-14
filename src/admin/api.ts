/**
 * What the admin panel is allowed to do.
 *
 * One rule shapes everything here: **no secret crosses this boundary.** A password is accepted
 * only as a `${env:NAME}` reference, never as a literal, and values read back from disk are
 * redacted before they leave. That is not caution for its own sake — a panel that took a
 * password over HTTP would put a credential through Node's memory and an HTTP request for the
 * first time, and would tempt the operator into storing it in a file instead of the environment.
 *
 * Secrets that already sit literally in a destination file (someone exported it from the BTP
 * cockpit) are preserved untouched on write: the panel patches the fields it owns and copies the
 * rest through, so editing a destination never silently drops its client secret.
 */
import fs from "node:fs";
import https from "node:https";
import tls from "node:tls";
import http from "node:http";
import path from "node:path";
import { URL } from "node:url";
import type { AppConfig, SapSystem } from "../config.js";
import { loadConfig } from "../config.js";
import { stripBom } from "../util/fs.js";
import { expandEnvRefs } from "../util/envref.js";
import { describeServiceKey, readServiceKeyFile } from "../btp/service-key.js";
import { exchangeRefreshToken, loginWithBrowser } from "../btp/login.js";
import { describeStoredToken, forgetRefreshToken, readRefreshToken, saveRefreshToken } from "../btp/token-store.js";
import { buildAuthHeaders, findDestination } from "./../btp/destinations.js";

export interface EnvRef {
  /** Variable named by a `${env:NAME}` reference. */
  name: string;
  resolved: boolean;
}

export interface SystemCard {
  name: string;
  url: string;
  client?: string;
  user?: string;
  /** How the password is configured — never the value. */
  password: { kind: "env-ref" | "literal" | "none"; envRefs: EnvRef[] };
}

export interface DestinationCard {
  name: string;
  url: string;
  authType: string;
  proxyType?: string;
  client?: string;
  user?: string;
  file: string;
  /** Names of the secret-bearing fields present, plus how each is configured. */
  secrets: { field: string; kind: "env-ref" | "literal"; envRefs: EnvRef[] }[];
  customHeaders: string[];
  /** Set when the destination takes its OAuth credentials from a service key file. */
  serviceKey?: { path: string; ok: boolean; detail: string };
}

const ENV_REF = /\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g;
const SECRET_FIELDS = ["password", "Password", "clientSecret", "clientsecret", "ClientSecret", "tokenServicePassword", "userToken"];

function envRefsOf(value: string): EnvRef[] {
  return [...value.matchAll(ENV_REF)].map((m) => ({ name: m[1], resolved: !!process.env[m[1]] }));
}

function classify(value: string | undefined): { kind: "env-ref" | "literal" | "none"; envRefs: EnvRef[] } {
  if (!value) return { kind: "none", envRefs: [] };
  const refs = envRefsOf(value);
  return refs.length ? { kind: "env-ref", envRefs: refs } : { kind: "literal", envRefs: [] };
}

// --- paths ------------------------------------------------------------------

export function paths(): { dataDir: string; systemsFile: string; destinationsDir: string } {
  const config = loadConfig([]);
  return {
    dataDir: config.dataDir,
    systemsFile: process.env.SAP_SYSTEMS_FILE?.trim() || path.join(config.dataDir, "systems.json"),
    destinationsDir: process.env.SAP_DESTINATIONS_DIR?.trim() || path.join(config.dataDir, "destinations")
  };
}

function readJsonFile<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(stripBom(fs.readFileSync(file, "utf8"))) as T;
  } catch {
    return fallback;
  }
}

/** Always UTF-8 without a BOM: the whole point is that the next reader does not trip over one. */
function writeJsonFile(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n", { encoding: "utf8" });
}

// --- systems ----------------------------------------------------------------

type RawSystem = Record<string, unknown>;

function rawSystems(): RawSystem[] {
  const { systemsFile } = paths();
  const raw = readJsonFile<unknown>(systemsFile, []);
  if (Array.isArray(raw)) return raw as RawSystem[];
  if (raw && typeof raw === "object" && Array.isArray((raw as { systems?: unknown }).systems)) {
    return (raw as { systems: RawSystem[] }).systems;
  }
  return [];
}

export function listSystems(): { file: string; systems: SystemCard[] } {
  const { systemsFile } = paths();
  return {
    file: systemsFile,
    systems: rawSystems().map((s) => ({
      name: String(s.name ?? ""),
      url: String(s.url ?? ""),
      client: s.client ? String(s.client) : undefined,
      user: s.user ? String(s.user) : undefined,
      password: classify(typeof s.password === "string" ? s.password : undefined)
    }))
  };
}

export interface SystemPatch {
  name: string;
  url: string;
  client?: string;
  user?: string;
  /** Must be a `${env:NAME}` reference or empty. A literal is refused. */
  password?: string;
  /** Present when renaming: the entry to replace. */
  previousName?: string;
}

export function saveSystem(patch: SystemPatch): { ok: true } {
  const name = patch.name.trim();
  if (!name) throw new Error("A system needs a name.");
  if (!patch.url.trim()) throw new Error(`System '${name}' needs a URL, e.g. https://host:44300`);
  assertUrl(patch.url, name);

  const password = (patch.password ?? "").trim();
  if (password && !ENV_REF.test(password)) {
    ENV_REF.lastIndex = 0;
    throw new Error(
      "The password must be an environment reference such as ${env:SAP_A4H_PASSWORD}, not the password itself. " +
        "This panel never stores or transports a credential."
    );
  }
  ENV_REF.lastIndex = 0;

  const list = rawSystems();
  const nameAt = (i: number) => String(list[i].name ?? "").toLowerCase();
  const existing = list.findIndex((_, i) => nameAt(i) === name.toLowerCase());

  // An edit says which entry it is editing; a create does not. Without that distinction a
  // create that reuses a name would silently overwrite a working connection.
  let index = -1;
  if (patch.previousName) {
    index = list.findIndex((_, i) => nameAt(i) === patch.previousName!.toLowerCase());
    if (index < 0) throw new Error(`No system called '${patch.previousName}' to edit.`);
    if (existing >= 0 && existing !== index) throw new Error(`Cannot rename to '${name}': another system already uses that name.`);
  } else if (existing >= 0) {
    throw new Error(`A system called '${name}' already exists. Edit it, or choose another name.`);
  }

  // keep any field the panel does not own (someone may have added authType by hand)
  const previous = index >= 0 ? list[index] : {};
  const entry: RawSystem = { ...previous, name, url: patch.url.trim() };
  setOrDelete(entry, "client", patch.client);
  setOrDelete(entry, "user", patch.user);
  setOrDelete(entry, "password", password);

  if (index >= 0) list[index] = entry;
  else list.push(entry);
  writeJsonFile(paths().systemsFile, list);
  return { ok: true };
}

export function deleteSystem(name: string): { ok: true } {
  const list = rawSystems();
  const next = list.filter((s) => String(s.name ?? "").toLowerCase() !== name.toLowerCase());
  if (next.length === list.length) throw new Error(`No system called '${name}'.`);
  writeJsonFile(paths().systemsFile, next);
  return { ok: true };
}

function setOrDelete(target: RawSystem, key: string, value: string | undefined): void {
  const v = (value ?? "").trim();
  if (v) target[key] = v;
  else delete target[key];
}

function assertUrl(url: string, subject: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`'${url}' is not a URL. Use the full form, e.g. https://host:44300 (${subject}).`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`'${url}' must use http or https (${subject}).`);
  }
}

// --- destinations -----------------------------------------------------------

function destinationFiles(): string[] {
  const { destinationsDir } = paths();
  try {
    return fs
      .readdirSync(destinationsDir)
      .filter((f) => f.toLowerCase().endsWith(".json"))
      .sort()
      .map((f) => path.join(destinationsDir, f));
  } catch {
    return [];
  }
}

const pick = (raw: Record<string, unknown>, keys: string[]): string => {
  for (const k of keys) {
    const v = raw[k];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number") return String(v);
  }
  return "";
};

export function listDestinations(): { dir: string; destinations: DestinationCard[] } {
  const { destinationsDir } = paths();
  const cards: DestinationCard[] = [];
  for (const file of destinationFiles()) {
    const raw = readJsonFile<Record<string, unknown>>(file, {});
    const headers = (raw.headers ?? raw.URLHeaders ?? raw.Headers) as Record<string, unknown> | undefined;
    cards.push({
      name: pick(raw, ["Name", "name"]) || path.basename(file, ".json"),
      url: pick(raw, ["URL", "url"]),
      authType: pick(raw, ["Authentication", "authType", "authentication"]) || "NoAuthentication",
      proxyType: pick(raw, ["ProxyType", "proxyType"]) || undefined,
      client: pick(raw, ["sap-client", "client"]) || undefined,
      user: pick(raw, ["User", "user", "username"]) || undefined,
      file,
      secrets: SECRET_FIELDS.filter((f) => typeof raw[f] === "string" && (raw[f] as string).trim()).map((f) => {
        const c = classify(raw[f] as string);
        return { field: f, kind: c.kind === "none" ? "literal" : c.kind, envRefs: c.envRefs };
      }),
      customHeaders: headers && typeof headers === "object" ? Object.keys(headers) : [],
      serviceKey: serviceKeyCard(pick(raw, ["serviceKeyPath", "ServiceKeyPath", "serviceKeyFile"]))
    });
  }
  return { dir: destinationsDir, destinations: cards };
}

/** Read a service key only to report what it is; the secret never leaves this function. */
function serviceKeyCard(file: string): DestinationCard["serviceKey"] {
  if (!file) return undefined;
  try {
    const key = readServiceKeyFile(file);
    return {
      path: file,
      ok: true,
      detail: `${key.kind} · client ${key.clientId.slice(0, 18)}… · UAA ${key.tokenUrl}`
    };
  } catch (e) {
    return { path: file, ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

/** Inspect a service key before saving, so the panel can show what it will configure. */
export function inspectServiceKey(file: string): Record<string, unknown> {
  return describeServiceKey(readServiceKeyFile(file));
}

export interface DestinationPatch {
  name: string;
  url: string;
  authType: string;
  proxyType?: string;
  client?: string;
  user?: string;
  password?: string;
  /** Path to a BTP service key; fills clientId, clientSecret and tokenServiceUrl at load time. */
  serviceKeyPath?: string;
  previousName?: string;
}

export function saveDestination(patch: DestinationPatch): { ok: true; file: string } {
  const name = patch.name.trim();
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new Error(`'${name}' is not a usable destination name. Use letters, digits, dot, dash or underscore — it becomes the file name.`);
  }
  assertUrl(patch.url, name);
  const password = (patch.password ?? "").trim();
  if (password && !ENV_REF.test(password)) {
    ENV_REF.lastIndex = 0;
    throw new Error("The password must be an environment reference such as ${env:MY_PASSWORD}, not the password itself.");
  }
  ENV_REF.lastIndex = 0;

  const { destinationsDir } = paths();
  const file = path.join(destinationsDir, `${name}.json`);
  const previousFile = patch.previousName ? path.join(destinationsDir, `${patch.previousName}.json`) : file;
  // carry every field we do not own straight through, so an exported clientSecret survives an edit
  const existing = readJsonFile<Record<string, unknown>>(previousFile, {});

  // Validate the key now, so a typo in the path surfaces here and not as a token request failing
  // hours later. Only the path is stored — the secret stays in the key file.
  if (patch.serviceKeyPath) readServiceKeyFile(patch.serviceKeyPath);

  const out: Record<string, unknown> = { ...existing };
  out.Name = name;
  out.URL = patch.url.trim();
  out.Authentication = patch.authType;
  setOrDelete(out, "ProxyType", patch.proxyType);
  setOrDelete(out, "sap-client", patch.client);
  setOrDelete(out, "User", patch.user);
  setOrDelete(out, "serviceKeyPath", patch.serviceKeyPath);
  if (password) out.Password = password;
  // drop the lowercase twins so one destination never carries two spellings of the same field
  for (const k of ["name", "url", "authType", "authentication", "proxyType", "client", "user", "username", "password"]) delete out[k];

  writeJsonFile(file, out);
  if (previousFile !== file && fs.existsSync(previousFile)) fs.rmSync(previousFile);
  return { ok: true, file };
}

export function deleteDestination(name: string): { ok: true } {
  const file = path.join(paths().destinationsDir, `${name}.json`);
  if (!fs.existsSync(file)) throw new Error(`No destination file for '${name}'.`);
  fs.rmSync(file);
  return { ok: true };
}

// --- connection test --------------------------------------------------------

export interface ProbeStep {
  label: string;
  path: string;
  status: number | null;
  ok: boolean;
  detail?: string;
}

export interface ValidateResult {
  target: string;
  url: string;
  tls: { trusted: boolean; subject?: string; issuer?: string; note?: string };
  sapSystem?: string;
  realm?: string;
  steps: ProbeStep[];
  /** Scopes carried by the access token, when it is a readable JWT. */
  scopes?: string[];
  verdict: string;
}

interface Probe {
  status: number | null;
  headers: Record<string, string>;
  body: string;
  error?: string;
  cert?: { subject?: string; issuer?: string };
}

/**
 * One request, with certificate verification reported rather than enforced.
 *
 * Development and training systems ship SAP's default self-signed certificate, so refusing to
 * connect would make the panel useless exactly where it is needed. Instead the panel connects
 * and tells the operator the certificate is not trusted, which is the fact they need.
 */
function request(target: string, extraHeaders: Record<string, string>, timeoutMs: number): Promise<Probe> {
  return new Promise((resolve) => {
    let parsed: URL;
    try {
      parsed = new URL(target);
    } catch {
      resolve({ status: null, headers: {}, body: "", error: "invalid URL" });
      return;
    }
    const secure = parsed.protocol === "https:";
    const lib = secure ? https : http;
    const headers: Record<string, string> = { accept: "*/*", ...extraHeaders };
    const req = lib.request(
      target,
      { method: "GET", headers, timeout: timeoutMs, ...(secure ? { rejectUnauthorized: false } : {}) },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.length < 40 && chunks.push(c as Buffer));
        res.on("end", () => {
          const flat: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) flat[k] = Array.isArray(v) ? v.join(", ") : String(v ?? "");
          let cert: { subject?: string; issuer?: string } | undefined;
          const socket = res.socket as unknown as { getPeerCertificate?: () => Record<string, Record<string, string>> };
          if (secure && typeof socket?.getPeerCertificate === "function") {
            const c = socket.getPeerCertificate();
            if (c && c.subject) cert = { subject: c.subject.CN, issuer: c.issuer?.CN ?? c.issuer?.O };
          }
          resolve({ status: res.statusCode ?? null, headers: flat, body: Buffer.concat(chunks).toString("utf8").slice(0, 2000), cert });
        });
      }
    );
    req.on("timeout", () => {
      req.destroy();
      resolve({ status: null, headers: {}, body: "", error: `no answer within ${timeoutMs} ms` });
    });
    req.on("error", (e) => resolve({ status: null, headers: {}, body: "", error: e.message }));
    req.end();
  });
}

/**
 * Ask the certificate directly, once, before any request.
 *
 * Doing this as a race alongside the real request reported "trusted" whenever the verifying
 * connection had not failed *yet* — a false clean bill of health on exactly the systems that
 * carry SAP's self-signed default certificate. One handshake answers both questions at once:
 * `authorized` is the verdict, and the peer certificate is readable either way.
 */
function checkTls(target: string, timeoutMs: number): Promise<ValidateResult["tls"]> {
  return new Promise((resolve) => {
    let parsed: URL;
    try {
      parsed = new URL(target);
    } catch {
      resolve({ trusted: true });
      return;
    }
    if (parsed.protocol !== "https:") {
      resolve({ trusted: true, note: "Plain HTTP: nothing is encrypted in transit." });
      return;
    }
    const socket = tls.connect(
      { host: parsed.hostname, port: Number(parsed.port || 443), servername: parsed.hostname, rejectUnauthorized: false, timeout: timeoutMs },
      () => {
        const cert = socket.getPeerCertificate();
        const trusted = socket.authorized;
        // a distinguished-name field can legitimately repeat, so it may arrive as an array
        const one = (v: unknown): string | undefined => (Array.isArray(v) ? v[0] : typeof v === "string" ? v : undefined);
        const out: ValidateResult["tls"] = {
          trusted,
          subject: one(cert?.subject?.CN),
          issuer: one(cert?.issuer?.CN) ?? one(cert?.issuer?.O)
        };
        if (!trusted) {
          out.note =
            `Certificate not trusted (${socket.authorizationError ?? "verification failed"}). Normal on a development system carrying SAP's default certificate; ` +
            "the panel connected without verifying it, and the MCP server needs NODE_TLS_REJECT_UNAUTHORIZED=0 or a trusted certificate to reach it.";
        }
        socket.destroy();
        resolve(out);
      }
    );
    socket.on("timeout", () => { socket.destroy(); resolve({ trusted: false, note: "TLS handshake timed out." }); });
    socket.on("error", (e) => resolve({ trusted: false, note: `TLS handshake failed: ${e.message}` }));
  });
}

/**
 * What an access token is actually allowed to do.
 *
 * An XSUAA token is a JWT whose payload lists its scopes, and that list is the difference between
 * a credential problem and an authorisation one. A client-credentials token for an ABAP
 * Environment can come back carrying only `uaa.resource` — perfectly valid, and useless against
 * ABAP, which then answers 401 as if the credentials were wrong. Showing the scopes turns hours
 * of suspecting the service key into one glance.
 */
function tokenScopes(authorization: string | undefined): string[] | null {
  const jwt = authorization?.startsWith("Bearer ") ? authorization.slice(7) : null;
  const payload = jwt?.split(".")[1];
  if (!payload) return null;
  try {
    const decoded = JSON.parse(Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")) as {
      scope?: string[] | string;
    };
    const scope = decoded.scope;
    if (Array.isArray(scope)) return scope;
    return typeof scope === "string" ? scope.split(" ").filter(Boolean) : null;
  } catch {
    return null; // an opaque token is a fine answer; it just cannot be described
  }
}

/** Pull the readable sentence out of an SAP error page or OData error payload. */
function sapMessage(body: string): string | undefined {
  const odata = /"message"\s*:\s*(?:"([^"]{4,300})"|\{[^}]*"value"\s*:\s*"([^"]{4,300})")/.exec(body);
  if (odata) return (odata[1] ?? odata[2])?.trim();
  const text = body.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  const known = /(Anmeldung fehlgeschlagen|Logon failed|No authorization[^.]*|not authorized[^.]*)/i.exec(text);
  return known ? known[1] : undefined;
}

/**
 * Walk a target from "is anything there" to "can I read a service", stopping at the first
 * answer that settles it. Each step reports what SAP said, because "401" alone is what cost
 * hours: the useful part is the realm naming the system, or the message naming the reason.
 */
export async function validateSystem(name: string, servicePath?: string, timeoutMs = 20000): Promise<ValidateResult> {
  const config: AppConfig = loadConfig([]);
  const system = config.sapSystems.find((s) => s.name.toLowerCase() === name.toLowerCase());
  if (!system) throw new Error(`No system called '${name}'. Save it first.`);
  return validateTarget(system, servicePath, timeoutMs);
}

export async function validateTarget(system: SapSystem, servicePath: string | undefined, timeoutMs: number): Promise<ValidateResult> {
  const base = system.url.replace(/\/$/, "");
  const clientParam = system.client ? `?sap-client=${encodeURIComponent(system.client)}` : "";
  const auth: Record<string, string> =
    system.user && system.password
      ? { authorization: `Basic ${Buffer.from(`${system.user}:${system.password}`).toString("base64")}` }
      : {};
  const steps: ProbeStep[] = [];
  const result: ValidateResult = { target: system.name, url: base, tls: await checkTls(base, timeoutMs), steps, verdict: "" };

  const run = async (label: string, rel: string, withAuth: boolean) => {
    const probe = await request(`${base}${rel}`, withAuth ? auth : {}, timeoutMs);
    result.sapSystem ??= probe.headers["sap-system"];
    const realm = /realm="([^"]+)"/.exec(probe.headers["www-authenticate"] ?? "");
    if (realm) result.realm ??= realm[1];
    const step: ProbeStep = {
      label,
      path: rel,
      status: probe.status,
      ok: probe.status !== null && probe.status < 400,
      detail: probe.error ?? sapMessage(probe.body)
    };
    steps.push(step);
    return step;
  };

  const reach = await run("Host reachable", `/sap/public/ping`, false);
  if (reach.status === null) {
    result.verdict = `No answer from ${base}. Check host and port — an SAP HTTPS port is usually 443NN, while 32NN is the SAP GUI dispatcher and does not speak HTTP.`;
    return result;
  }

  if (!system.user || !system.password) {
    result.verdict = system.user
      ? "No password resolved. If it is written as ${env:NAME}, that variable is empty in the process running this panel."
      : "Reachable, but no user is configured, so only anonymous endpoints were tried.";
    return result;
  }

  const logon = await run("Credentials accepted", `/sap/bc/ping${clientParam}`, true);
  if (logon.status === 401) {
    result.verdict =
      `Logon rejected by ${result.realm ?? "the server"}. The credentials are wrong for this system or client` +
      (result.sapSystem ? `, which identifies itself as ${result.sapSystem}` : "") +
      ". Check that the user exists in this client, and that an initial password has already been changed.";
    return result;
  }
  if (!logon.ok) {
    result.verdict = `Logon endpoint answered HTTP ${logon.status}${logon.detail ? `: ${logon.detail}` : ""}.`;
    return result;
  }

  if (servicePath) {
    const meta = await run("Service metadata", `${servicePath.replace(/\/$/, "")}/$metadata${clientParam}`, true);
    if (meta.status === 403) {
      result.verdict = `Logon works, but this user may not start that service${meta.detail ? `: ${meta.detail}` : "."}`;
      return result;
    }
    result.verdict = meta.ok
      ? `Working: logon accepted and $metadata readable${result.sapSystem ? ` on ${result.sapSystem}` : ""}.`
      : `Logon works; the service answered HTTP ${meta.status}${meta.detail ? `: ${meta.detail}` : ""}.`;
    return result;
  }

  result.verdict = `Logon accepted${result.sapSystem ? ` on ${result.sapSystem}` : ""}. Add a service path to check a concrete OData service.`;
  return result;
}

/**
 * Test a destination, token exchange included.
 *
 * For an OAuth destination the interesting question is not whether the host answers — it is
 * whether the client credentials in the service key still buy a token. `buildAuthHeaders` is the
 * same code path the tools use, so a failure here is the failure a tool would hit.
 */
export async function validateDestination(name: string, servicePath?: string, timeoutMs = 20000): Promise<ValidateResult> {
  const config = loadConfig([]);
  const destination = await findDestination(config, name, timeoutMs);
  if (!destination) throw new Error(`No destination called '${name}'.`);

  const base = destination.url.replace(/\/$/, "");
  const clientParam = destination.client ? `?sap-client=${encodeURIComponent(destination.client)}` : "";
  const steps: ProbeStep[] = [];
  const result: ValidateResult = { target: destination.name, url: base, tls: await checkTls(base, timeoutMs), steps, verdict: "" };

  if (!base) {
    result.verdict = "This destination has no URL, so there is nothing to reach.";
    return result;
  }

  const probe = await request(base, {}, timeoutMs);
  result.sapSystem ??= probe.headers["sap-system"];
  steps.push({ label: "Host reachable", path: "/", status: probe.status, ok: probe.status !== null, detail: probe.error });
  if (probe.status === null) {
    result.verdict = `No answer from ${base}. ${probe.error ?? ""}`.trim();
    return result;
  }

  let headers: Record<string, string>;
  try {
    headers = await buildAuthHeaders(destination, timeoutMs, config.dataDir);
    const scopes = tokenScopes(headers.authorization);
    const kind = headers.authorization?.startsWith("Basic ") ? "Basic" : headers.authorization ? "Bearer (token obtained)" : "none";
    steps.push({
      label: `Authentication resolved (${destination.authType})`,
      path: destination.tokenServiceUrl ?? "-",
      status: 200,
      ok: true,
      detail: scopes ? `${kind} · scopes: ${scopes.slice(0, 6).join(", ")}${scopes.length > 6 ? `, +${scopes.length - 6}` : ""}` : kind
    });
    result.scopes = scopes ?? undefined;
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    steps.push({ label: `Authentication resolved (${destination.authType})`, path: destination.tokenServiceUrl ?? "-", status: null, ok: false, detail });
    result.verdict = destination.serviceKeyPath
      ? `The service key at ${destination.serviceKeyPath} did not produce a token: ${detail}`
      : `Authentication could not be resolved: ${detail}`;
    return result;
  }

  const target = servicePath ? `${base}${servicePath.replace(/\/$/, "")}/$metadata${clientParam}` : `${base}${clientParam}`;
  const call = await request(target, headers, timeoutMs);
  const redirect = call.headers["location"];
  steps.push({
    label: servicePath ? "Service metadata" : "Endpoint with credentials",
    path: servicePath ? `${servicePath}/$metadata` : "/",
    status: call.status,
    // a redirect is not an answer: it neither accepted nor rejected the token
    ok: call.status !== null && call.status < 300,
    detail: call.error ?? (redirect ? `redirected to ${redirect}` : undefined) ?? sapMessage(call.body)
  });

  if (call.status === 401) {
    const abapScopes = (result.scopes ?? []).filter((s) => !s.startsWith("uaa."));
    result.verdict = abapScopes.length
      ? "The token was obtained but the service rejected it. The client has scopes on this system, so this looks like a missing authorisation for this particular service rather than a bad credential."
      : "The token was obtained and carries no scope for this system — only UAA's own. That is why it is refused: the OAuth client has no authorisation here, which no amount of re-issuing the key will change. A named-user token (OAuth2RefreshToken) or a communication arrangement grants one.";
  } else if (call.status === 403) {
    result.verdict = `Authenticated, but not authorised${call.body ? `: ${sapMessage(call.body) ?? "no detail given"}` : "."}`;
  } else if (call.status !== null && call.status >= 300 && call.status < 400) {
    // saying "working" here would repeat the mistake of trusting a status that proves nothing
    result.verdict =
      `The token was obtained, but the endpoint answered ${call.status} and redirected${redirect ? ` to ${redirect}` : ""}, ` +
      "which proves nothing about whether the token is accepted. Give a service path to test a concrete OData service.";
  } else if (call.status !== null && call.status < 300) {
    result.verdict = servicePath
      ? "Working: token accepted and the service answered."
      : "Working: token obtained and the endpoint answered. A service path would test a concrete service.";
  } else {
    result.verdict = `Token obtained; the endpoint answered HTTP ${call.status}.`;
  }
  return result;
}

// --- the BTP token behind a destination -------------------------------------

export interface TokenStatus {
  destination: string;
  serviceKeyPath?: string;
  keyError?: string;
  identityProvider?: string;
  stored: boolean;
  sealed?: "dpapi" | "plain";
  storedAt?: string;
  /** Present after a validate: what the tenant said about the token. */
  valid?: boolean;
  detail?: string;
  expiresInSeconds?: number;
}

function destinationKey(name: string) {
  const config = loadConfig([]);
  const found = loadDestinationsForPanel().find((d) => d.name.toLowerCase() === name.toLowerCase());
  if (!found) throw new Error(`No destination called '${name}'.`);
  if (!found.serviceKeyPath) {
    throw new Error(`Destination '${found.name}' has no service key, so it has no BTP token to manage.`);
  }
  return { config, destination: found, key: readServiceKeyFile(found.serviceKeyPath) };
}

/** The destination cards, read straight from disk so the panel never works from a stale copy. */
function loadDestinationsForPanel() {
  return listDestinations().destinations.map((d) => ({ name: d.name, serviceKeyPath: d.serviceKey?.path }));
}

export function tokenStatus(name: string): TokenStatus {
  const config = loadConfig([]);
  const card = listDestinations().destinations.find((d) => d.name.toLowerCase() === name.toLowerCase());
  if (!card) throw new Error(`No destination called '${name}'.`);
  const stored = describeStoredToken(config.dataDir, card.name);
  return {
    destination: card.name,
    serviceKeyPath: card.serviceKey?.path,
    keyError: card.serviceKey && !card.serviceKey.ok ? card.serviceKey.detail : undefined,
    stored: stored.stored,
    sealed: stored.kind,
    storedAt: stored.storedAt
  };
}

/** Ask the tenant whether the stored token still works, which is the only authority on it. */
export async function tokenValidate(name: string): Promise<TokenStatus> {
  const status = tokenStatus(name);
  const { config, key } = destinationKey(name);
  const token = readRefreshToken(config.dataDir, status.destination);
  if (!token) {
    return { ...status, valid: false, detail: "No token is stored for this destination yet. Sign in once to obtain one." };
  }
  try {
    const result = await exchangeRefreshToken(key, token);
    return { ...status, valid: true, expiresInSeconds: result.expiresInSeconds, detail: `The tenant issued an access token valid for ${Math.round(result.expiresInSeconds / 60)} minutes.` };
  } catch (e) {
    return { ...status, valid: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Sign in from the panel.
 *
 * The browser opens on this machine, which is where the operator already is — the panel binds to
 * loopback, so there is nowhere else it could be. The token is stored the same way `--btp-login`
 * stores it, and no part of it is returned to the page.
 */
export async function tokenLogin(name: string): Promise<TokenStatus & { identityProvider?: string }> {
  const { config, key } = destinationKey(name);
  let idp: string | undefined;
  const result = await loginWithBrowser(key, { timeoutSeconds: 300, onIdentityProvider: (host) => (idp = host) });
  const saved = saveRefreshToken(config.dataDir, name, result.refreshToken);
  return {
    ...tokenStatus(name),
    identityProvider: idp,
    valid: true,
    sealed: saved.kind,
    detail: saved.sealError
      ? `Signed in and stored${idp ? ` after ${idp}` : ""}, but DPAPI did not seal it: ${saved.sealError}`
      : `Signed in and stored${idp ? ` after ${idp}` : ""}. Nothing else has to be configured.`
  };
}

export function tokenForget(name: string): { removed: boolean } {
  const config = loadConfig([]);
  return { removed: forgetRefreshToken(config.dataDir, name) };
}

/** Everything the page renders in one call. */
export function state(): {
  systems: ReturnType<typeof listSystems>;
  destinations: ReturnType<typeof listDestinations>;
  destinationService: { configured: boolean; source: string; detail?: string };
  warnings: string[];
  dataDir: string;
} {
  const config = loadConfig([]);
  return {
    systems: listSystems(),
    destinations: listDestinations(),
    destinationService: destinationServiceCard(),
    warnings: config.configWarnings,
    dataDir: config.dataDir
  };
}

/** Where the cloud Destination Service credentials come from, if anywhere. */
function destinationServiceCard(): { configured: boolean; source: string; detail?: string } {
  const keyFile = process.env.BTP_SERVICE_KEY_FILE?.trim();
  if (keyFile) {
    try {
      const key = readServiceKeyFile(keyFile);
      return key.apiUrl
        ? { configured: true, source: `service key: ${keyFile}`, detail: `API ${key.apiUrl} · UAA ${key.tokenUrl}` }
        : { configured: false, source: `service key: ${keyFile}`, detail: `This is a ${key.kind} key, not a destination service key — it has no "uri" field.` };
    } catch (e) {
      return { configured: false, source: `service key: ${keyFile}`, detail: e instanceof Error ? e.message : String(e) };
    }
  }
  const vars = ["BTP_DESTINATION_API_URL", "BTP_TOKEN_URL", "BTP_CLIENT_ID", "BTP_CLIENT_SECRET"];
  const missing = vars.filter((v) => !process.env[v]);
  if (!missing.length) return { configured: true, source: "environment variables" };
  if (process.env.VCAP_SERVICES) return { configured: true, source: "VCAP_SERVICES binding" };
  return {
    configured: false,
    source: "not configured",
    detail: `Point BTP_SERVICE_KEY_FILE at the destination service key downloaded from the cockpit, or set ${missing.join(", ")}.`
  };
}

/** Resolve a `${env:NAME}` the way the server will, to show whether it is actually set. */
export function envStatus(names: string[]): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const n of names) out[n] = expandEnvRefs(`\${env:${n}}`) !== "";
  return out;
}
