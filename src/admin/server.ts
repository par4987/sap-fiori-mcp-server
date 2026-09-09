/**
 * Local admin panel: `sap-fiori-mcp --admin`.
 *
 * This process edits the files that grant access to real SAP systems, so four things keep it
 * from becoming a hole in the machine:
 *
 *   1. It binds to 127.0.0.1 only. Never 0.0.0.0, and the flag to change that does not exist.
 *   2. Every request needs a token generated fresh at each launch and printed once. Without it
 *      the panel is a 401, so a process that merely knows the port gets nothing.
 *   3. The token travels in a header and the server sets no cookies, so a page in another tab
 *      cannot make the browser attach it. That removes CSRF rather than mitigating it.
 *   4. Every request must carry a Host naming the loopback address. Binding to 127.0.0.1 keeps
 *      remote packets out but not the operator's own browser: a hostname the attacker controls,
 *      re-pointed at 127.0.0.1 after the page loads, reaches this port from inside. The Host
 *      header still says the attacker's name while it happens, so checking it closes that door.
 *
 * And the rule from api.ts holds here too: no route returns a secret, and none accepts one.
 */
import http from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import * as api from "./api.js";
import { PAGE } from "./page.js";

const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;

function tokenOk(given: string | undefined, token: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  // timingSafeEqual throws on a length mismatch, so compare lengths first
  return a.length === b.length && timingSafeEqual(a, b);
}

function readBody(req: http.IncomingMessage, limit = 64 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

type Handler = (body: Record<string, unknown>) => unknown | Promise<unknown>;

const str = (v: unknown, field: string): string => {
  if (typeof v !== "string") throw new Error(`'${field}' must be text.`);
  return v;
};
const opt = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

const ROUTES: Record<string, Handler> = {
  "/api/state": () => api.state(),
  "/api/systems/save": (b) =>
    api.saveSystem({
      name: str(b.name, "name"),
      url: str(b.url, "url"),
      client: opt(b.client),
      user: opt(b.user),
      password: opt(b.password),
      previousName: opt(b.previousName)
    }),
  "/api/systems/delete": (b) => api.deleteSystem(str(b.name, "name")),
  "/api/destinations/save": (b) =>
    api.saveDestination({
      name: str(b.name, "name"),
      url: str(b.url, "url"),
      authType: str(b.authType, "authType"),
      proxyType: opt(b.proxyType),
      client: opt(b.client),
      user: opt(b.user),
      password: opt(b.password),
      serviceKeyPath: opt(b.serviceKeyPath),
      previousName: opt(b.previousName)
    }),
  "/api/service-key/inspect": (b) => api.inspectServiceKey(str(b.path, "path")),
  "/api/token/status": (b) => api.tokenStatus(str(b.name, "name")),
  "/api/token/validate": (b) => api.tokenValidate(str(b.name, "name")),
  "/api/token/login": (b) => api.tokenLogin(str(b.name, "name")),
  "/api/token/forget": (b) => api.tokenForget(str(b.name, "name")),
  "/api/destinations/delete": (b) => api.deleteDestination(str(b.name, "name")),
  "/api/validate": (b) =>
    opt(b.kind) === "destination"
      ? api.validateDestination(str(b.name, "name"), opt(b.servicePath))
      : api.validateSystem(str(b.name, "name"), opt(b.servicePath))
};

export interface AdminHandle {
  server: http.Server;
  url: string;
  token: string;
}

export function startAdminServer(port = Number(process.env.SAP_FIORI_MCP_ADMIN_PORT ?? 7392)): Promise<AdminHandle> {
  const token = randomBytes(24).toString("hex");

  const server = http.createServer(async (req, res) => {
    const send = (status: number, payload: unknown, type = "application/json") => {
      const text = type === "application/json" ? JSON.stringify(payload) : String(payload);
      res.writeHead(status, {
        "content-type": `${type}; charset=utf-8`,
        // the panel must never be framed, cached or sniffed
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
        "x-frame-options": "DENY",
        "referrer-policy": "no-referrer"
      });
      res.end(text);
    };

    if (!LOOPBACK.test(req.headers.host ?? "")) {
      send(403, { error: "This panel answers only to a loopback Host header." });
      return;
    }
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    // The page itself is fetched with the token in the query string, because a browser opening
    // a link cannot set a header. The page strips it from the address bar immediately.
    if (req.method === "GET" && url.pathname === "/") {
      if (!tokenOk(url.searchParams.get("token") ?? undefined, token)) {
        send(401, "Open the link printed by the server; it carries the one-time token.", "text/plain");
        return;
      }
      send(200, PAGE, "text/html");
      return;
    }

    const handler = ROUTES[url.pathname];
    if (!handler) {
      send(404, { error: "No such route." });
      return;
    }
    if (req.method !== "POST" && url.pathname !== "/api/state") {
      send(405, { error: "Use POST." });
      return;
    }
    if (!tokenOk(req.headers["x-admin-token"] as string | undefined, token)) {
      send(401, { error: "Missing or invalid admin token." });
      return;
    }

    try {
      const raw = req.method === "POST" ? await readBody(req) : "{}";
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      send(200, { ok: true, data: await handler(body) });
    } catch (e) {
      // the message is written for the operator; nothing here reveals a stored value
      send(400, { ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      const actual = typeof address === "object" && address ? address.port : port;
      resolve({ server, url: `http://127.0.0.1:${actual}/?token=${token}`, token });
    });
  });
}
