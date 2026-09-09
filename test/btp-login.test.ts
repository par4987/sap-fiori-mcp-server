/**
 * The interactive login, driven without a browser.
 *
 * The authorization code comes back through the operating system's URL handler and lands on a
 * loopback port any local process could have raced for, so most of what is worth testing is what
 * the callback refuses: a mismatched state, an error from the identity provider, a code with no
 * PKCE verifier behind it.
 */
import { describe, it, expect, vi } from "vitest";
import { loginWithBrowser } from "../src/btp/login.js";
import type { ParsedServiceKey } from "../src/btp/service-key.js";

const KEY: ParsedServiceKey = {
  kind: "abap-environment",
  clientId: "sb-abap!t123",
  clientSecret: "abap-secret",
  tokenUrl: "https://tenant.authentication.us10.hana.ondemand.com",
  endpointUrl: "https://abap.example",
  systemId: "TRL",
  unusedTopLevelKeys: []
};

/** Start a login, capture the authorize URL, and hand back a way to drive the callback. */
async function startLogin(over: Partial<Parameters<typeof loginWithBrowser>[1]> = {}) {
  let authorizeUrl!: URL;
  const seen = new Promise<URL>((resolve) => {
    void loginWithBrowser(KEY, {
      noBrowser: true,
      timeoutSeconds: 10,
      onUrl: (u) => resolve(new URL(u)),
      ...over
    }).catch(() => undefined);
  });
  authorizeUrl = await seen;
  const redirect = new URL(authorizeUrl.searchParams.get("redirect_uri")!);
  return { authorizeUrl, callback: (query: string) => fetch(`http://127.0.0.1:${redirect.port}/callback?${query}`) };
}

describe("the authorize request", () => {
  it("asks for a code with PKCE and a loopback redirect", async () => {
    const { authorizeUrl } = await startLogin();
    expect(authorizeUrl.pathname).toBe("/oauth/authorize");
    expect(authorizeUrl.searchParams.get("response_type")).toBe("code");
    expect(authorizeUrl.searchParams.get("client_id")).toBe(KEY.clientId);
    expect(authorizeUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorizeUrl.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(authorizeUrl.searchParams.get("state")).toBeTruthy();
    expect(authorizeUrl.searchParams.get("redirect_uri")).toMatch(/^http:\/\/localhost:\d+\/callback$/);
  });

  // the secret authenticates the token exchange, and has no business in a URL the browser sees
  it("never puts the client secret in the browser URL", async () => {
    const { authorizeUrl } = await startLogin();
    expect(authorizeUrl.toString()).not.toContain(KEY.clientSecret);
  });
});

describe("the callback", () => {
  it("refuses a code whose state does not belong to this attempt", async () => {
    const { callback } = await startLogin();
    const res = await callback("code=stolen&state=someone-elses");
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("state");
  });

  it("reports what the identity provider said when it refuses", async () => {
    const { authorizeUrl, callback } = await startLogin();
    const state = authorizeUrl.searchParams.get("state")!;
    const res = await callback(`error=access_denied&error_description=User+cancelled&state=${state}`);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("access_denied");
  });

  it("exchanges a valid code, sending the PKCE verifier and the client secret", async () => {
    const original = globalThis.fetch;
    const calls: { url: string; body: URLSearchParams; auth: string }[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/oauth/token")) {
        calls.push({
          url,
          body: new URLSearchParams(String(init?.body ?? "")),
          auth: String((init?.headers as Record<string, string>)?.authorization ?? "")
        });
        return new Response(JSON.stringify({ access_token: "at", refresh_token: "rt-123", expires_in: 3600 }), { status: 200 });
      }
      return original(input as string, init);
    }) as typeof fetch;

    try {
      let authorizeUrl!: URL;
      const login = loginWithBrowser(KEY, { noBrowser: true, timeoutSeconds: 10, onUrl: (u) => (authorizeUrl = new URL(u)) });
      await vi.waitFor(() => expect(authorizeUrl).toBeDefined());
      const redirect = new URL(authorizeUrl.searchParams.get("redirect_uri")!);
      const state = authorizeUrl.searchParams.get("state")!;
      await fetch(`http://127.0.0.1:${redirect.port}/callback?code=the-code&state=${encodeURIComponent(state)}`);

      const result = await login;
      expect(result.refreshToken).toBe("rt-123");
      expect(calls).toHaveLength(1);
      expect(calls[0].body.get("grant_type")).toBe("authorization_code");
      expect(calls[0].body.get("code")).toBe("the-code");
      expect(calls[0].body.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(Buffer.from(calls[0].auth.replace("Basic ", ""), "base64").toString()).toBe("sb-abap!t123:abap-secret");
    } finally {
      globalThis.fetch = original;
    }
  });

  // A client that cannot refresh makes every later run interactive, which defeats the point
  it("says so when the UAA returns no refresh token", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes("/oauth/token")) return new Response(JSON.stringify({ access_token: "at" }), { status: 200 });
      return original(input as string, init);
    }) as typeof fetch;

    try {
      let authorizeUrl!: URL;
      const login = loginWithBrowser(KEY, { noBrowser: true, timeoutSeconds: 10, onUrl: (u) => (authorizeUrl = new URL(u)) });
      // attach the expectation before triggering the callback: the rejection can land during the
      // fetch below, and a promise that rejects with nobody listening is an unhandled rejection
      const assertion = expect(login).rejects.toThrow(/no refresh token/);
      await vi.waitFor(() => expect(authorizeUrl).toBeDefined());
      const redirect = new URL(authorizeUrl.searchParams.get("redirect_uri")!);
      await fetch(`http://127.0.0.1:${redirect.port}/callback?code=c&state=${encodeURIComponent(authorizeUrl.searchParams.get("state")!)}`);
      await assertion;
    } finally {
      globalThis.fetch = original;
    }
  });
});
