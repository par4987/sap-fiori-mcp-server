/**
 * Outbound request guard.
 *
 * The server performs HTTP calls to hosts that can come from three very different places:
 *   - configuration the user set up explicitly (SAP systems, local destinations, CDNs),
 *   - the BTP Destination Service (also explicitly configured by the user),
 *   - free-form `serviceUrl` arguments supplied by the LLM calling a tool.
 *
 * The last one is the SSRF-shaped vector: a URL that reaches the tool from untrusted
 * content (a document, an issue, a web page) and points at an internal endpoint.
 * `SAP_FIORI_MCP_ALLOWED_DOMAINS` restricts that case. When it is not set the guard only
 * enforces the protocol, so the default behaviour stays unrestricted.
 *
 * Hosts that come from the server's own configuration are always trusted: the user already
 * named them in systems.json / the destination definitions / the CDN settings.
 */
import type { AppConfig } from "../config.js";

export class BlockedHostError extends Error {
  constructor(host: string, allowed: string[]) {
    super(
      `Outbound request to '${host}' is blocked by SAP_FIORI_MCP_ALLOWED_DOMAINS. ` +
        `Allowed: ${allowed.join(", ")}. Add the host to SAP_FIORI_MCP_ALLOWED_DOMAINS (or unset it to allow every host), ` +
        `or reach the system through a configured SAP system / BTP destination instead of a raw URL.`
    );
    this.name = "BlockedHostError";
  }
}

function hostOf(url: string): string {
  return new URL(url).hostname.toLowerCase();
}

/** `*.example.com` matches sub.example.com and example.com; everything else is an exact host match. */
function hostMatches(host: string, pattern: string): boolean {
  const p = pattern.trim().toLowerCase();
  if (!p) return false;
  if (p === "*") return true;
  if (p.startsWith("*.")) {
    const base = p.slice(2);
    return host === base || host.endsWith(`.${base}`);
  }
  return host === p;
}

/** Hosts named by the server's own configuration, which are trusted regardless of the allowlist. */
export function configuredHosts(config: AppConfig, extraUrls: string[] = []): string[] {
  const urls = [
    ...config.sapSystems.map((s) => s.url),
    config.ui5CdnUrl,
    config.ui5TypesCdnUrl,
    "https://sdk.openui5.org",
    "https://ui5.sap.com",
    ...extraUrls
  ];
  const hosts: string[] = [];
  for (const u of urls) {
    if (!u) continue;
    try {
      hosts.push(hostOf(u));
    } catch {
      /* not a URL, ignore */
    }
  }
  return hosts;
}

/**
 * Throw unless `url` may be requested. Always rejects non-http(s) protocols;
 * only applies the host allowlist when one is configured.
 */
export function assertUrlAllowed(config: AppConfig, url: string, trustedUrls: string[] = []): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: '${url}'. Provide an absolute URL such as https://host:port/sap/opu/odata/sap/MY_SRV.`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Unsupported protocol '${parsed.protocol}' in '${url}'. Only http and https are allowed.`);
  }
  if (!config.allowedDomains.length) return; // allowlist not configured → unrestricted

  const host = parsed.hostname.toLowerCase();
  const allowed = [...config.allowedDomains, ...configuredHosts(config, trustedUrls)];
  if (!allowed.some((p) => hostMatches(host, p))) throw new BlockedHostError(host, config.allowedDomains);
}
