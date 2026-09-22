/**
 * One-time interactive BTP login: OAuth 2.0 authorization code with PKCE and a loopback redirect.
 *
 * A trial or corporate subaccount does not keep its users in the UAA — it delegates to an identity
 * provider, often with SSO and a second factor. There is no password to hand to a token endpoint,
 * so the only way to prove who you are is a real browser. What comes back is a refresh token,
 * which every later run exchanges without asking anyone anything.
 *
 * PKCE matters even though this client has a secret: the authorization code travels back through
 * the operating system's URL handler and lands on a loopback port any local process could have
 * raced for. The verifier never leaves this process, so a stolen code alone buys nothing.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { ParsedServiceKey } from "./service-key.js";

export interface LoginResult {
  refreshToken: string;
  accessToken: string;
  expiresInSeconds: number;
}

export interface LoginOptions {
  /** Seconds to wait for the browser round trip. */
  timeoutSeconds?: number;
  /** Print the URL instead of opening a browser — the case over SSH or in a container. */
  noBrowser?: boolean;
  /** Called with the authorize URL, so a caller can show it however it likes. */
  onUrl?: (url: string) => void;
  /** Called with the identity provider the tenant will hand the login to, when it can be found. */
  onIdentityProvider?: (host: string) => void;
}

const base64url = (b: Buffer): string => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function pkce(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  return { verifier, challenge: base64url(createHash("sha256").update(verifier).digest()) };
}

function sameString(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Open the login URL in the default browser.
 *
 * On Windows this must not go through `cmd /c start`. An authorize URL is full of `&`, which cmd
 * reads as a command separator: the browser receives everything up to the first parameter and
 * nothing after it, and the identity provider answers "Client id must not be empty" — a message
 * that blames the service key when the key was never the problem. Quoting does not save it, so the
 * URL travels in an environment variable where nothing re-parses it.
 */
function openBrowser(url: string): void {
  try {
    if (process.platform === "win32") {
      spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Start-Process $env:MCP_OPEN_URL"], {
        env: { ...process.env, MCP_OPEN_URL: url },
        detached: true,
        stdio: "ignore",
        windowsHide: true
      }).unref();
      return;
    }
    spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
  } catch {
    /* the caller prints the URL regardless */
  }
}

/**
 * Which identity provider the subaccount will actually ask.
 *
 * XSUAA answers the authorize request with a page that bounces the browser onward, and the host
 * it bounces to is the one that will demand credentials. Saying so before the browser opens
 * matters because BTP keeps two separate populations: the platform account used for the cockpit,
 * and the business user the applications know. They are rarely the same, and the login page names
 * neither — it just refuses the wrong one.
 */
async function identityProvider(authorizeUrl: string, timeoutMs: number): Promise<string | null> {
  try {
    const res = await fetch(authorizeUrl, { redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
    const html = await res.text();
    const meta = /<meta\s+name="redirect"\s+content="([^"]+)"/i.exec(html);
    const target = meta?.[1]?.replace(/&amp;/g, "&");
    return target ? new URL(target).host : null;
  } catch {
    return null; // best effort: never let a diagnostic aside block the login
  }
}

const PAGE = (title: string, detail: string, ok: boolean) => `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><title>${title}</title>
<style>body{font:16px/1.6 system-ui,sans-serif;background:#12141a;color:#e6e8ef;display:grid;place-items:center;height:100vh;margin:0}
div{max-width:34rem;padding:2rem;text-align:center}h1{font-size:1.2rem;color:${ok ? "#4ec9a4" : "#ff7b72"}}</style></head>
<body><div><h1>${title}</h1><p>${detail}</p></div></body></html>`;

/** Exchange the authorization code for tokens, authenticating the client with the service key. */
async function exchange(key: ParsedServiceKey, code: string, verifier: string, redirectUri: string, timeoutMs: number): Promise<LoginResult> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
    client_id: key.clientId
  });
  const res = await fetch(`${key.tokenUrl}/oauth/token`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Basic ${Buffer.from(`${key.clientId}:${key.clientSecret}`).toString("base64")}`
    },
    body: body.toString(),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 300);
    try {
      const parsed = JSON.parse(text) as { error?: string; error_description?: string };
      detail = parsed.error_description ?? parsed.error ?? detail;
    } catch {
      /* keep the raw body */
    }
    throw new Error(`The UAA refused the authorization code (HTTP ${res.status}): ${detail}`);
  }
  const json = JSON.parse(text) as { access_token?: string; refresh_token?: string; expires_in?: number };
  if (!json.refresh_token) {
    throw new Error(
      "The UAA returned no refresh token. The OAuth client may not be allowed the refresh_token grant, " +
        "which makes non-interactive use impossible with this service key."
    );
  }
  return { refreshToken: json.refresh_token, accessToken: json.access_token ?? "", expiresInSeconds: json.expires_in ?? 0 };
}

/**
 * Spend a refresh token on an access token, which is the only way to know it is still good.
 *
 * A stored token looks identical whether it works or expired last week; the tenant decides, and
 * only the token endpoint can say. This is what the panel's validate button asks.
 */
export async function exchangeRefreshToken(
  key: ParsedServiceKey,
  refreshToken: string,
  timeoutMs = 20000
): Promise<{ accessToken: string; expiresInSeconds: number }> {
  const res = await fetch(`${key.tokenUrl}/oauth/token`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Basic ${Buffer.from(`${key.clientId}:${key.clientSecret}`).toString("base64")}`
    },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }).toString(),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 240);
    try {
      const parsed = JSON.parse(text) as { error?: string; error_description?: string };
      detail = parsed.error_description ?? parsed.error ?? detail;
    } catch {
      /* keep the raw body */
    }
    throw new Error(`The UAA refused the refresh token (HTTP ${res.status}): ${detail}`);
  }
  const json = JSON.parse(text) as { access_token?: string; expires_in?: number };
  if (!json.access_token) throw new Error("The UAA answered without an access token.");
  return { accessToken: json.access_token, expiresInSeconds: json.expires_in ?? 0 };
}

export function loginWithBrowser(key: ParsedServiceKey, opts: LoginOptions = {}): Promise<LoginResult> {
  const timeoutMs = (opts.timeoutSeconds ?? 300) * 1000;
  const { verifier, challenge } = pkce();
  const state = base64url(randomBytes(16));

  return new Promise<LoginResult>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      fn();
    };

    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const reply = (status: number, title: string, detail: string, ok: boolean) => {
        res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(PAGE(title, detail, ok));
      };

      const returnedState = url.searchParams.get("state") ?? "";
      // binds this callback to this attempt: another page cannot feed us a code
      if (!sameString(returnedState, state)) {
        reply(400, "Login no válido", "El parámetro <code>state</code> no coincide con esta sesión de login.", false);
        finish(() => reject(new Error("OAuth state mismatch: the callback did not belong to this login attempt.")));
        return;
      }
      const error = url.searchParams.get("error");
      if (error) {
        const description = url.searchParams.get("error_description") ?? "";
        reply(400, "Login rechazado", `${error}. ${description}`, false);
        finish(() => reject(new Error(`The identity provider refused the login: ${error}. ${description}`.trim())));
        return;
      }
      const code = url.searchParams.get("code");
      if (!code) {
        reply(400, "Falta el código", "La respuesta no traía ningún código de autorización.", false);
        finish(() => reject(new Error("The callback carried no authorization code.")));
        return;
      }

      try {
        const result = await exchange(key, code, verifier, redirectUri, timeoutMs);
        reply(200, "Sesión iniciada", "Ya puedes cerrar esta pestaña y volver al terminal.", true);
        finish(() => resolve(result));
      } catch (e) {
        reply(500, "El intercambio falló", e instanceof Error ? e.message : String(e), false);
        finish(() => reject(e instanceof Error ? e : new Error(String(e))));
      }
    });

    const timer = setTimeout(() => {
      finish(() => reject(new Error(`No browser callback arrived within ${opts.timeoutSeconds ?? 300} s.`)));
    }, timeoutMs);

    let redirectUri = "";
    server.on("error", (e) => finish(() => reject(e)));
    // port 0: the OS picks a free one, and XSUAA accepts any loopback port
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      redirectUri = `http://localhost:${port}/callback`;

      const authorize = new URL(`${key.tokenUrl}/oauth/authorize`);
      authorize.searchParams.set("response_type", "code");
      authorize.searchParams.set("client_id", key.clientId);
      authorize.searchParams.set("redirect_uri", redirectUri);
      authorize.searchParams.set("state", state);
      authorize.searchParams.set("code_challenge", challenge);
      authorize.searchParams.set("code_challenge_method", "S256");

      const url = authorize.toString();
      // Open first. Naming the identity provider is a diagnostic aside that costs a network
      // round trip, and doing it first held the browser back by as much as its 10 s timeout
      // while the caller had already told the operator the browser was opening.
      opts.onUrl?.(url);
      if (!opts.noBrowser) openBrowser(url);
      if (opts.onIdentityProvider) {
        void identityProvider(url, 10000).then((host) => {
          if (host) opts.onIdentityProvider?.(host);
        });
      }
    });
  });
}
