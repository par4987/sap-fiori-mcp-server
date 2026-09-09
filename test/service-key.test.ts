/**
 * Service keys, in the shapes BTP actually emits.
 *
 * The point of parsing them is that an operator should never have to decide which URL is the
 * token service and which is the API — the three shapes below disagree about that, and getting
 * it wrong produces an OAuth failure hours later rather than an error at configuration time.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseServiceKey, readServiceKeyFile, describeServiceKey } from "../src/btp/service-key.js";
import { normalizeDestination, getDestinationServiceConfig } from "../src/btp/destinations.js";

const DESTINATION_KEY = {
  clientid: "sb-clone-abc!b123|destination-xsappname!b45",
  clientsecret: "destination-secret",
  uri: "https://destination-configuration.cfapps.eu10.hana.ondemand.com/",
  url: "https://mytenant.authentication.eu10.hana.ondemand.com",
  instanceid: "abc-123"
};

const ABAP_KEY = {
  url: "https://a1b2-c3d4.abap.us10.hana.ondemand.com",
  systemid: "TRL",
  uaa: {
    clientid: "sb-abap!t123",
    clientsecret: "abap-secret",
    url: "https://tenant.authentication.us10.hana.ondemand.com",
    identityzone: "tenant"
  }
};

const XSUAA_KEY = {
  clientid: "sb-app!t9",
  clientsecret: "xsuaa-secret",
  url: "https://tenant.authentication.eu10.hana.ondemand.com/oauth/token",
  xsappname: "app!t9"
};

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-key-"));
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});
const write = (name: string, data: unknown) => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
  return file;
};

describe("parseServiceKey", () => {
  it("reads a destination service key: uri is the API, url is the UAA", () => {
    const k = parseServiceKey(DESTINATION_KEY);
    expect(k.kind).toBe("destination");
    expect(k.apiUrl).toBe("https://destination-configuration.cfapps.eu10.hana.ondemand.com");
    expect(k.tokenUrl).toBe("https://mytenant.authentication.eu10.hana.ondemand.com");
    expect(k.clientId).toBe(DESTINATION_KEY.clientid);
  });

  it("reads an ABAP Environment key, whose credentials sit under uaa", () => {
    const k = parseServiceKey(ABAP_KEY);
    expect(k.kind).toBe("abap-environment");
    expect(k.endpointUrl).toBe("https://a1b2-c3d4.abap.us10.hana.ondemand.com");
    expect(k.tokenUrl).toBe("https://tenant.authentication.us10.hana.ondemand.com");
    expect(k.clientId).toBe("sb-abap!t123");
    expect(k.systemId).toBe("TRL");
  });

  // Some keys give the token endpoint itself; callers append /oauth/token, so it must come off
  it("normalises a UAA url that already ends in /oauth/token", () => {
    expect(parseServiceKey(XSUAA_KEY).tokenUrl).toBe("https://tenant.authentication.eu10.hana.ondemand.com");
  });

  it("refuses a JSON that is not a service key, and says what is missing", () => {
    expect(() => parseServiceKey({ hello: "world" })).toThrow(/clientid\/clientsecret/);
    expect(() => parseServiceKey([1, 2])).toThrow(/JSON object/);
  });

  it("never exposes the secret in the description shown by the panel", () => {
    const described = describeServiceKey(parseServiceKey(ABAP_KEY));
    expect(JSON.stringify(described)).not.toContain("abap-secret");
    expect(described.clientSecret).toBe("«redacted»");
  });

  it("names the file when the file is the problem", () => {
    const file = path.join(dir, "broken.json");
    fs.writeFileSync(file, "{ not json");
    expect(() => readServiceKeyFile(file)).toThrow(new RegExp(path.basename(file)));
    expect(() => readServiceKeyFile(path.join(dir, "absent.json"))).toThrow(/Cannot read the service key/);
  });
});

describe("a destination backed by a service key", () => {
  it("takes clientId, secret and token URL from the key instead of its own fields", () => {
    const file = write("abap.json", ABAP_KEY);
    const d = normalizeDestination({ Name: "TRL", Authentication: "OAuth2ClientCredentials", serviceKeyPath: file }, "file");
    expect(d.clientId).toBe("sb-abap!t123");
    expect(d.clientSecret).toBe("abap-secret");
    expect(d.tokenServiceUrl).toBe("https://tenant.authentication.us10.hana.ondemand.com");
    // the endpoint comes from the key too, so the destination needs no URL of its own
    expect(d.url).toBe("https://a1b2-c3d4.abap.us10.hana.ondemand.com");
    expect(d.serviceKeyPath).toBe(file);
  });

  it("keeps an explicit URL when the destination declares one", () => {
    const file = write("abap.json", ABAP_KEY);
    const d = normalizeDestination({ Name: "TRL", URL: "https://custom.example", serviceKeyPath: file }, "file");
    expect(d.url).toBe("https://custom.example");
  });

  it("survives a missing key file rather than throwing while listing destinations", () => {
    const d = normalizeDestination({ Name: "BROKEN", URL: "https://x", serviceKeyPath: path.join(dir, "nope.json") }, "file");
    expect(d.clientId).toBeUndefined();
    expect(d.url).toBe("https://x");
  });
});

describe("destination service from a service key", () => {
  it("configures itself from BTP_SERVICE_KEY_FILE", () => {
    vi.stubEnv("BTP_SERVICE_KEY_FILE", write("dest.json", DESTINATION_KEY));
    const cfg = getDestinationServiceConfig();
    expect(cfg).toEqual({
      apiUrl: "https://destination-configuration.cfapps.eu10.hana.ondemand.com",
      tokenUrl: "https://mytenant.authentication.eu10.hana.ondemand.com",
      clientId: DESTINATION_KEY.clientid,
      clientSecret: DESTINATION_KEY.clientsecret
    });
  });

  // An ABAP Environment key has no destination API, so using it here would be a silent misconfig
  it("declines a key that is not for the destination service", () => {
    vi.stubEnv("BTP_SERVICE_KEY_FILE", write("abap.json", ABAP_KEY));
    expect(getDestinationServiceConfig()).toBeNull();
  });

  it("still honours the four separate variables", () => {
    vi.stubEnv("BTP_DESTINATION_API_URL", "https://api.example/");
    vi.stubEnv("BTP_TOKEN_URL", "https://uaa.example/");
    vi.stubEnv("BTP_CLIENT_ID", "cid");
    vi.stubEnv("BTP_CLIENT_SECRET", "secret");
    expect(getDestinationServiceConfig()?.apiUrl).toBe("https://api.example");
  });
});
