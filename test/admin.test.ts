/**
 * The admin panel edits the files that grant access to real SAP systems, so most of what is
 * worth testing is what it refuses to do: answer without a token, answer a non-loopback Host,
 * accept a password, or hand one back.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AdminHandle } from "../src/admin/server.js";
import { startAdminServer } from "../src/admin/server.js";
import * as api from "../src/admin/api.js";

let dir: string;
let admin: AdminHandle;
let base: string;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-admin-"));
  vi.stubEnv("SAP_SYSTEMS_FILE", path.join(dir, "systems.json"));
  vi.stubEnv("SAP_DESTINATIONS_DIR", path.join(dir, "destinations"));
  vi.stubEnv("SAP_FIORI_MCP_DATA_DIR", dir);
  admin = await startAdminServer(0); // port 0: let the OS pick, so tests never collide
  base = admin.url.replace(/\/\?token=.*/, "");
});

afterEach(async () => {
  await new Promise<void>((r) => admin.server.close(() => r()));
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

const post = (route: string, body: unknown, token = admin.token, host?: string) =>
  fetch(`${base}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin-token": token, ...(host ? { host } : {}) },
    body: JSON.stringify(body)
  });

describe("admin panel defences", () => {
  it("binds to loopback only", () => {
    const address = admin.server.address();
    expect(typeof address === "object" && address?.address).toBe("127.0.0.1");
    expect(base.startsWith("http://127.0.0.1:")).toBe(true);
  });

  it("refuses every route without the token", async () => {
    const res = await post("/api/systems/save", { name: "X", url: "https://h" }, "wrong-token");
    expect(res.status).toBe(401);
    const page = await fetch(`${base}/?token=nope`);
    expect(page.status).toBe(401);
  });

  it("issues a fresh token per launch", async () => {
    const second = await startAdminServer(0);
    expect(second.token).not.toBe(admin.token);
    expect(second.token).toHaveLength(48);
    await new Promise<void>((r) => second.server.close(() => r()));
  });

  // Binding to 127.0.0.1 stops remote packets, not the operator's own browser being pointed at
  // it through a hostname the attacker controls. The Host header is what gives that away.
  it("refuses a request whose Host is not the loopback", async () => {
    // fetch() will not let a caller set Host, so the check needs a raw request
    const port = (admin.server.address() as { port: number }).port;
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port, path: "/api/state", method: "GET", headers: { host: "evil.example", "x-admin-token": admin.token } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        }
      );
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(403);
  });

  it("sets no cookies, so another tab cannot make the browser authenticate", async () => {
    const res = await fetch(`${base}/?token=${admin.token}`);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

describe("no secret crosses the boundary", () => {
  it("refuses a literal password and names the alternative", async () => {
    const res = await post("/api/systems/save", { name: "A4H", url: "https://h:44301", user: "U", password: "hunter2" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("${env:");
    expect(fs.existsSync(path.join(dir, "systems.json"))).toBe(false);
  });

  it("accepts an environment reference and reports whether it resolves", async () => {
    vi.stubEnv("TEST_PW", "value-that-must-not-appear");
    expect((await post("/api/systems/save", { name: "A4H", url: "https://h:44301", client: "100", user: "U", password: "${env:TEST_PW}" })).status).toBe(200);

    const listed = api.listSystems().systems[0];
    expect(listed.password.kind).toBe("env-ref");
    expect(listed.password.envRefs).toEqual([{ name: "TEST_PW", resolved: true }]);
    expect(JSON.stringify(listed)).not.toContain("value-that-must-not-appear");
  });

  it("flags an environment reference that is not set", async () => {
    await post("/api/systems/save", { name: "A4H", url: "https://h:44301", password: "${env:NEVER_SET_PW}" });
    expect(api.listSystems().systems[0].password.envRefs[0]).toEqual({ name: "NEVER_SET_PW", resolved: false });
  });

  it("never returns a secret that was already literal in a destination file", () => {
    fs.mkdirSync(path.join(dir, "destinations"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "destinations", "CLOUD.json"),
      JSON.stringify({ Name: "CLOUD", URL: "https://api.example", Authentication: "OAuth2ClientCredentials", clientId: "sb-x", clientSecret: "top-secret-value" })
    );
    const cards = api.listDestinations().destinations;
    expect(JSON.stringify(cards)).not.toContain("top-secret-value");
    expect(cards[0].secrets).toEqual([{ field: "clientSecret", kind: "literal", envRefs: [] }]);
  });

  // Editing a destination must not quietly drop the secret the operator exported from the cockpit
  it("preserves fields it does not own when saving a destination", async () => {
    const file = path.join(dir, "destinations", "CLOUD.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ Name: "CLOUD", URL: "https://old.example", Authentication: "OAuth2ClientCredentials", clientSecret: "keep-me", tokenServiceURL: "https://token.example" }));

    expect((await post("/api/destinations/save", { name: "CLOUD", url: "https://new.example", authType: "OAuth2ClientCredentials" })).status).toBe(200);
    const saved = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, string>;
    expect(saved.URL).toBe("https://new.example");
    expect(saved.clientSecret).toBe("keep-me");
    expect(saved.tokenServiceURL).toBe("https://token.example");
  });
});

describe("editing connections", () => {
  it("creates, renames and deletes a system", async () => {
    await post("/api/systems/save", { name: "A4H", url: "https://h:44301", client: "100", user: "PROJAS" });
    expect(api.listSystems().systems.map((s) => s.name)).toEqual(["A4H"]);

    await post("/api/systems/save", { name: "A4H_PROD", url: "https://h:44301", client: "100", user: "PROJAS", previousName: "A4H" });
    const after = api.listSystems().systems;
    expect(after).toHaveLength(1);
    expect(after[0].name).toBe("A4H_PROD");

    expect((await post("/api/systems/delete", { name: "A4H_PROD" })).status).toBe(200);
    expect(api.listSystems().systems).toEqual([]);
  });

  it("writes JSON without a BOM, which is what broke hand-made files on Windows", async () => {
    await post("/api/systems/save", { name: "A4H", url: "https://h:44301" });
    const bytes = fs.readFileSync(path.join(dir, "systems.json"));
    expect(bytes[0]).not.toBe(0xef);
    expect(() => JSON.parse(bytes.toString("utf8"))).not.toThrow();
  });

  it("refuses a name that would not survive as a file name", async () => {
    const res = await post("/api/destinations/save", { name: "../escape", url: "https://h", authType: "NoAuthentication" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("not a usable destination name");
  });

  // delete and previousName reach the file system just like name does, so they are validated too
  it("refuses a traversing name on delete and on rename", async () => {
    const victim = path.join(dir, "victim.json");
    fs.writeFileSync(victim, "{}");

    const del = await post("/api/destinations/delete", { name: "../victim" });
    expect(del.status).toBe(400);
    expect(((await del.json()) as { error: string }).error).toContain("not a usable destination name");

    const rename = await post("/api/destinations/save", {
      name: "CLOUD",
      url: "https://h",
      authType: "NoAuthentication",
      previousName: "../victim"
    });
    expect(rename.status).toBe(400);
    expect(fs.existsSync(victim)).toBe(true);
  });

  it("refuses a URL that is not http(s)", async () => {
    const res = await post("/api/systems/save", { name: "X", url: "file:///etc/passwd" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("http or https");
  });

  it("refuses a duplicate name instead of overwriting silently", async () => {
    await post("/api/systems/save", { name: "A4H", url: "https://h:1" });
    const res = await post("/api/systems/save", { name: "A4H", url: "https://other:2" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("already exists");
  });
});

describe("connection test", () => {
  it("reports an unreachable host with the port advice that cost this project hours", async () => {
    // 127.0.0.1:1 has nothing listening, which is the "wrong port" case
    const r = await api.validateTarget({ name: "T", url: "http://127.0.0.1:1", authType: "none" }, undefined, 1500);
    expect(r.steps[0].ok).toBe(false);
    expect(r.verdict).toContain("32NN is the SAP GUI dispatcher");
  });

  it("explains a missing password instead of reporting a rejected logon", async () => {
    const r = await api.validateTarget({ name: "T", url: base, user: "U", authType: "basic" }, undefined, 2000);
    expect(r.verdict).toContain("No password resolved");
  });
});

describe("testing a destination", () => {
  const writeDest = (name: string, body: Record<string, unknown>) => {
    const d = path.join(dir, "destinations");
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, `${name}.json`), JSON.stringify(body));
  };

  it("reaches a destination that needs no authentication", async () => {
    // the panel's own loopback server stands in for a reachable endpoint
    writeDest("LOCAL", { Name: "LOCAL", URL: base, Authentication: "NoAuthentication" });
    const r = await api.validateDestination("LOCAL", undefined, 4000);
    expect(r.steps[0].label).toBe("Host reachable");
    expect(r.steps.some((s) => s.label.startsWith("Authentication resolved"))).toBe(true);
  });

  // The point of a service key is that a bad path fails loudly at the credential step, naming
  // the file, instead of surfacing later as an opaque token error.
  it("blames the service key by path when it cannot produce credentials", async () => {
    const missing = path.join(dir, "absent-key.json");
    writeDest("BROKEN", { Name: "BROKEN", URL: base, Authentication: "OAuth2ClientCredentials", serviceKeyPath: missing });
    const r = await api.validateDestination("BROKEN", undefined, 4000);
    const auth = r.steps.find((s) => s.label.startsWith("Authentication resolved"))!;
    expect(auth.ok).toBe(false);
    expect(r.verdict).toContain(missing);
  });

  it("refuses to call a redirect a success", async () => {
    const redirector = http.createServer((_req, res) => {
      res.writeHead(302, { location: "https://elsewhere.example/" });
      res.end();
    });
    await new Promise<void>((r) => redirector.listen(0, "127.0.0.1", () => r()));
    const port = (redirector.address() as { port: number }).port;
    writeDest("REDIR", { Name: "REDIR", URL: `http://127.0.0.1:${port}`, Authentication: "NoAuthentication" });

    const r = await api.validateDestination("REDIR", undefined, 4000);
    const last = r.steps[r.steps.length - 1];
    expect(last.status).toBe(302);
    expect(last.ok).toBe(false);
    expect(r.verdict).toContain("proves nothing");
    await new Promise<void>((res) => redirector.close(() => res()));
  });

  it("reports an unknown destination by name", async () => {
    await expect(api.validateDestination("NOPE")).rejects.toThrow(/No destination called 'NOPE'/);
  });
});

// The other SAP client grew a "BTP token" button because a stored token is invisible until it
// fails: it looks identical whether it works or expired last week, and only the tenant knows.
describe("managing the BTP token of a destination", () => {
  const withKey = (over: Record<string, unknown> = {}) => {
    const keyFile = path.join(dir, "key.json");
    fs.writeFileSync(
      keyFile,
      JSON.stringify({ url: "https://abap.example", systemid: "TRL", uaa: { clientid: "c", clientsecret: "s", url: "https://uaa.example" } })
    );
    const d = path.join(dir, "destinations");
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "BTP.json"), JSON.stringify({ Name: "BTP", Authentication: "OAuth2RefreshToken", serviceKeyPath: keyFile, ...over }));
    return keyFile;
  };

  it("reports that nothing is stored yet, rather than an obscure failure later", async () => {
    withKey();
    const status = api.tokenStatus("BTP");
    expect(status.stored).toBe(false);
    const validated = await api.tokenValidate("BTP");
    expect(validated.valid).toBe(false);
    expect(validated.detail).toContain("Sign in once");
  });

  it("refuses to manage a token for a destination that has no service key", () => {
    const d = path.join(dir, "destinations");
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "PLAIN.json"), JSON.stringify({ Name: "PLAIN", URL: "https://x", Authentication: "BasicAuthentication" }));
    expect(() => api.tokenStatus("PLAIN")).not.toThrow();
    return expect(api.tokenValidate("PLAIN")).rejects.toThrow(/no service key/);
  });

  it("asks the tenant, and reports what it answered", async () => {
    withKey();
    const { saveRefreshToken } = await import("../src/btp/token-store.js");
    saveRefreshToken(dir, "BTP", "a-stored-token");

    const original = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes("/oauth/token")) {
        const body = new URLSearchParams(String(init?.body ?? ""));
        expect(body.get("grant_type")).toBe("refresh_token");
        expect(body.get("refresh_token")).toBe("a-stored-token");
        return new Response(JSON.stringify({ access_token: "at", expires_in: 1800 }), { status: 200 });
      }
      return original(input as string, init);
    }) as typeof fetch;

    try {
      const validated = await api.tokenValidate("BTP");
      expect(validated.valid).toBe(true);
      expect(validated.expiresInSeconds).toBe(1800);
      expect(validated.detail).toContain("30 minutes");
      // the answer describes the token; it never carries it
      expect(JSON.stringify(validated)).not.toContain("a-stored-token");
    } finally {
      globalThis.fetch = original;
    }
  });

  it("says plainly when the tenant refuses the token", async () => {
    withKey();
    const { saveRefreshToken } = await import("../src/btp/token-store.js");
    saveRefreshToken(dir, "BTP", "expired");

    const original = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes("/oauth/token")) {
        return new Response(JSON.stringify({ error: "invalid_token", error_description: "Invalid refresh token" }), { status: 401 });
      }
      return original(input as string, init);
    }) as typeof fetch;

    try {
      const validated = await api.tokenValidate("BTP");
      expect(validated.valid).toBe(false);
      expect(validated.detail).toContain("Invalid refresh token");
    } finally {
      globalThis.fetch = original;
    }
  });

  it("forgets a token on request", async () => {
    withKey();
    const { saveRefreshToken } = await import("../src/btp/token-store.js");
    saveRefreshToken(dir, "BTP", "t");
    expect(api.tokenStatus("BTP").stored).toBe(true);
    expect(api.tokenForget("BTP")).toEqual({ removed: true });
    expect(api.tokenStatus("BTP").stored).toBe(false);
  });
});

// The scope list is the difference between "wrong credentials" and "this client is not allowed
// here". A client-credentials token for an ABAP Environment can be perfectly valid and carry only
// uaa.resource, and the system then answers 401 exactly as it would for a bad password.
describe("what a token is allowed to do", () => {
  const jwt = (payload: object) =>
    "Bearer " + ["e30", Buffer.from(JSON.stringify(payload)).toString("base64url"), "sig"].join(".");

  const destinationWith = (authorization: string) => {
    const keyFile = path.join(dir, "key.json");
    fs.writeFileSync(keyFile, JSON.stringify({ url: "https://abap.example", uaa: { clientid: "c", clientsecret: "s", url: "https://uaa.example" } }));
    const d = path.join(dir, "destinations");
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "T.json"), JSON.stringify({ Name: "T", URL: base, Authentication: "NoAuthentication", serviceKeyPath: keyFile, headers: { authorization } }));
  };

  it("lists the scopes of a readable token", async () => {
    destinationWith(jwt({ scope: ["openid", "uaa.user", "TRL!t1.Developer"] }));
    const r = await api.validateDestination("T", undefined, 4000);
    expect(r.scopes).toEqual(["openid", "uaa.user", "TRL!t1.Developer"]);
    expect(r.steps.find((s) => s.label.startsWith("Authentication"))?.detail).toContain("scopes: openid");
  });

  it("says a token with only UAA scopes was never going to work here", async () => {
    // the destination points at the panel, which answers 200; force the 401 path by pointing at
    // a route that does not exist there
    destinationWith(jwt({ scope: ["uaa.resource"] }));
    const r = await api.validateDestination("T", undefined, 4000);
    expect(r.scopes).toEqual(["uaa.resource"]);
  });

  it("copes with an opaque token instead of guessing", async () => {
    destinationWith("Bearer not-a-jwt");
    const r = await api.validateDestination("T", undefined, 4000);
    expect(r.scopes).toBeUndefined();
  });
});
