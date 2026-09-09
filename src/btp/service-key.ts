/**
 * Service keys, taken as they come out of the BTP cockpit.
 *
 * A service key is what an operator actually has in hand: one JSON blob downloaded from the
 * cockpit or printed by `cf create-service-key`. Asking them to take it apart — which URL is the
 * token service, which is the API, where the client id goes — is asking them to do a mapping the
 * machine can do, and to get it wrong quietly.
 *
 * BTP emits at least three shapes for the same idea, so all three are read here:
 *
 *   Destination service   { clientid, clientsecret, uri, url }
 *                         `uri` is the destination API, `url` the UAA token service.
 *   ABAP Environment      { url, systemid, uaa: { clientid, clientsecret, url } }
 *                         `url` is the ABAP endpoint; the credentials live one level down.
 *   Plain XSUAA           { clientid, clientsecret, url, xsappname }
 *
 * The file itself stays on disk and is read at load time: pointing a destination at a service key
 * keeps the client secret out of the destination file and out of any HTTP request.
 */
import fs from "node:fs";
import { stripBom } from "../util/fs.js";

export type ServiceKeyKind = "destination" | "abap-environment" | "xsuaa" | "unknown";

export interface ParsedServiceKey {
  kind: ServiceKeyKind;
  clientId: string;
  clientSecret: string;
  /** UAA base, without the /oauth/token suffix that callers add themselves. */
  tokenUrl: string;
  /** Destination service API root, when the key is for the destination service. */
  apiUrl?: string;
  /** The service's own endpoint — the ABAP system URL for an ABAP Environment key. */
  endpointUrl?: string;
  /**
   * The `-web` twin of the endpoint, which serves the Fiori launchpad and browser-facing apps.
   *
   * It is reported because it exists and is easy to confuse with the API host, not because APIs
   * live there: reached without a browser session it answers 200 with a login page, which is
   * harder to diagnose than the API host's honest 401. OData services are consumed on the host
   * the key names, with a named-user token.
   */
  webEndpointUrl?: string;
  systemId?: string;
  /** Fields the key carried that this parser did not recognise, for diagnostics. */
  unusedTopLevelKeys: string[];
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");
const trimSlash = (v: string): string => v.replace(/\/+$/, "");

/** Some keys carry the token endpoint itself rather than the UAA root. */
function uaaRoot(url: string): string {
  return trimSlash(url).replace(/\/oauth\/token$/i, "");
}

export function parseServiceKey(raw: unknown): ParsedServiceKey {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("A service key must be a JSON object, exactly as downloaded from the BTP cockpit.");
  }
  const key = raw as Record<string, unknown>;
  const uaa = (key.uaa && typeof key.uaa === "object" ? key.uaa : {}) as Record<string, unknown>;

  const clientId = str(uaa.clientid) || str(key.clientid) || str(key.clientId);
  const clientSecret = str(uaa.clientsecret) || str(key.clientsecret) || str(key.clientSecret);
  const tokenUrl = uaaRoot(str(uaa.url) || str(key.url && !key.uri ? "" : key.url) || str(key.url));

  if (!clientId || !clientSecret) {
    throw new Error(
      "This JSON has no clientid/clientsecret. A destination service key has them at the top level; " +
        "an ABAP Environment key keeps them under \"uaa\". Check you downloaded the key and not the service instance."
    );
  }

  const parsed: ParsedServiceKey = {
    kind: "unknown",
    clientId,
    clientSecret,
    tokenUrl,
    unusedTopLevelKeys: []
  };

  if (str(key.uri)) {
    // destination service: uri is the API, url is the UAA
    parsed.kind = "destination";
    parsed.apiUrl = trimSlash(str(key.uri));
    parsed.tokenUrl = uaaRoot(str(key.url));
  } else if (Object.keys(uaa).length) {
    parsed.kind = "abap-environment";
    parsed.endpointUrl = trimSlash(str(key.url));
    const abapHost = /^(https?:\/\/[^.]+)\.abap\.(.+)$/.exec(parsed.endpointUrl);
    if (abapHost) parsed.webEndpointUrl = `${abapHost[1]}.abap-web.${abapHost[2]}`;
    parsed.systemId = str(key.systemid) || undefined;
    parsed.tokenUrl = uaaRoot(str(uaa.url));
  } else if (str(key.xsappname)) {
    parsed.kind = "xsuaa";
    parsed.tokenUrl = uaaRoot(str(key.url));
  }

  if (!parsed.tokenUrl) {
    throw new Error("This service key has no UAA url, so no token can ever be requested with it.");
  }

  const known = new Set(["clientid", "clientId", "clientsecret", "clientSecret", "url", "uri", "uaa", "systemid", "xsappname", "identityzone", "tenantid", "tenantmode", "verificationkey", "apiurl", "sburl", "instanceid", "credential-type", "catalogs", "endpoints"]);
  parsed.unusedTopLevelKeys = Object.keys(key).filter((k) => !known.has(k));
  return parsed;
}

/** Read and parse a service key file, with errors that name the file. */
export function readServiceKeyFile(file: string): ParsedServiceKey {
  let text: string;
  try {
    text = stripBom(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`Cannot read the service key at ${file}: ${e instanceof Error ? e.message : String(e)}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error(`${file} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    return parseServiceKey(json);
  } catch (e) {
    throw new Error(`${file}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** What the panel may show about a key: everything except the secret. */
export function describeServiceKey(key: ParsedServiceKey): Record<string, unknown> {
  return {
    kind: key.kind,
    clientId: key.clientId,
    clientSecret: "«redacted»",
    tokenUrl: key.tokenUrl,
    apiUrl: key.apiUrl,
    endpointUrl: key.endpointUrl,
    webEndpointUrl: key.webEndpointUrl,
    systemId: key.systemId,
    unusedTopLevelKeys: key.unusedTopLevelKeys
  };
}
