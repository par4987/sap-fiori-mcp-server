import { describe, it, expect, afterEach, beforeAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig, type AppConfig } from "../src/config.js";
import { createMcpServer } from "../src/server.js";
import {
  normalizeDestination,
  loadDestinations,
  redactDestination,
  buildAuthHeaders,
  getDestinationServiceConfig,
  fetchServiceDestination,
  resolveODataTarget,
  findDestination
} from "../src/btp/destinations.js";
import { resolveFloorplan } from "../src/fiori/generate.js";
import { feManifest } from "../src/fiori/templates.js";
import { createUi5App } from "../src/ui5/scaffold.js";

let config: AppConfig;

beforeAll(() => {
  config = loadConfig(["--port", "3999"]);
  config.logLevel = "off";
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { forEach: (cb: (v: string, k: string) => void) => cb("application/json", "content-type") },
    text: async () => text,
    json: async () => body
  } as unknown as Response;
}

describe("BTP destinations: loading and normalization", () => {
  it("normalizes cockpit format and camelCase", () => {
    const cockpit = normalizeDestination({ Name: "S4H", URL: "https://s4:44300", Authentication: "BasicAuthentication", User: "dev", Password: "pw", "sap-client": "100" }, "env");
    expect(cockpit.name).toBe("S4H");
    expect(cockpit.authType).toBe("BasicAuthentication");
    expect(cockpit.client).toBe("100");

    const camel = normalizeDestination({ name: "sfsf", url: "https://api", authType: "OAuth2ClientCredentials", clientId: "cid", clientSecret: "cs", tokenServiceUrl: "https://auth" }, "file");
    expect(camel.authType).toBe("OAuth2ClientCredentials");
    expect(camel.clientId).toBe("cid");
  });

  it("loads destinations from SAP_DESTINATIONS_JSON", () => {
    vi.stubEnv("SAP_DESTINATIONS_JSON", JSON.stringify([{ Name: "D1", URL: "https://d1", Authentication: "NoAuthentication" }, { Name: "D2", URL: "https://d2", Authentication: "BasicAuthentication", User: "u", Password: "p" }]));
    const list = loadDestinations(config);
    expect(list.map((d) => d.name)).toEqual(["D1", "D2"]);
  });

  it("loads destinations from SAP_DESTINATIONS_DIR files", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-dest-"));
    fs.writeFileSync(path.join(dir, "erp.json"), JSON.stringify({ Name: "ERP", URL: "https://erp" }));
    vi.stubEnv("SAP_DESTINATIONS_DIR", dir);
    const list = loadDestinations(config);
    expect(list.map((d) => d.name)).toContain("ERP");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("redacts secrets in output", () => {
    const d = normalizeDestination({ Name: "S", URL: "https://s", Authentication: "BasicAuthentication", User: "u", Password: "supersecret", clientSecret: "cs-secret" }, "env");
    const red = JSON.stringify(redactDestination(d));
    expect(red).not.toContain("supersecret");
    expect(red).not.toContain("cs-secret");
  });
});

describe("BTP destinations: auth headers", () => {
  it("builds Basic auth headers", async () => {
    const d = normalizeDestination({ Name: "B", URL: "https://b", Authentication: "BasicAuthentication", User: "dev", Password: "pw", "sap-client": "100" }, "env");
    const headers = await buildAuthHeaders(d);
    expect(headers.authorization).toBe(`Basic ${Buffer.from("dev:pw").toString("base64")}`);
    expect(headers["sap-client"]).toBe("100");
  });

  it("exchanges OAuth2ClientCredentials tokens", async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      expect(String(url)).toContain("https://auth.example.com/oauth/token");
      return jsonResponse({ access_token: "tok123" });
    });
    vi.stubGlobal("fetch", fetchMock);
    const d = normalizeDestination({ Name: "O", URL: "https://o", Authentication: "OAuth2ClientCredentials", clientId: "cid", clientSecret: "cs", tokenServiceUrl: "https://auth.example.com" }, "env");
    const headers = await buildAuthHeaders(d);
    expect(headers.authorization).toBe("Bearer tok123");
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe("BTP Destination Service", () => {
  it("detects explicit env configuration", () => {
    vi.stubEnv("BTP_CLIENT_ID", "cid");
    vi.stubEnv("BTP_CLIENT_SECRET", "cs");
    vi.stubEnv("BTP_TOKEN_URL", "https://subaccount.authentication.eu10.hana.ondemand.com");
    vi.stubEnv("BTP_DESTINATION_API_URL", "https://destination-configuration.cfapps.eu10.hana.ondemand.com");
    const svc = getDestinationServiceConfig();
    expect(svc).not.toBeNull();
    expect(svc!.apiUrl).toContain("destination-configuration");
  });

  it("fetches a destination with pre-exchanged authTokens", async () => {
    vi.stubEnv("BTP_CLIENT_ID", "cid");
    vi.stubEnv("BTP_CLIENT_SECRET", "cs");
    vi.stubEnv("BTP_TOKEN_URL", "https://auth");
    vi.stubEnv("BTP_DESTINATION_API_URL", "https://dest-api");
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.startsWith("https://auth/oauth/token")) return jsonResponse({ access_token: "xstoken" });
      if (u.includes("/destination-configuration/v1/destinations/S4H")) {
        return jsonResponse({
          destinationConfiguration: { Name: "S4H", URL: "https://s4h.example.com", Authentication: "OAuth2ClientCredentials" },
          authTokens: [{ type: "Bearer", value: "pre", http_header: { Authorization: "Bearer pre-exchanged" } }]
        });
      }
      return jsonResponse({}, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    const svc = getDestinationServiceConfig()!;
    const d = await fetchServiceDestination(svc, "S4H", 5000);
    expect(d).not.toBeNull();
    expect(d!.name).toBe("S4H");
    expect(d!.source).toBe("destination-service");
    const headers = await buildAuthHeaders(d!);
    expect(headers.authorization).toBe("Bearer pre-exchanged");
  });

  it("findDestination falls back to the destination service", async () => {
    vi.stubEnv("BTP_CLIENT_ID", "cid");
    vi.stubEnv("BTP_CLIENT_SECRET", "cs");
    vi.stubEnv("BTP_TOKEN_URL", "https://auth");
    vi.stubEnv("BTP_DESTINATION_API_URL", "https://dest-api");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        const u = String(url);
        if (u.startsWith("https://auth/oauth/token")) return jsonResponse({ access_token: "t" });
        if (u.includes("/destinations/CLOUD")) return jsonResponse({ destinationConfiguration: { Name: "CLOUD", URL: "https://cloud.example.com", Authentication: "NoAuthentication" } });
        return jsonResponse({}, 404);
      })
    );
    const d = await findDestination(config, "CLOUD", 5000);
    expect(d).not.toBeNull();
    expect(d!.url).toBe("https://cloud.example.com");
  });
});

describe("resolveODataTarget", () => {
  it("composes destination URL + servicePath with auth headers", async () => {
    vi.stubEnv("SAP_DESTINATIONS_JSON", JSON.stringify([{ Name: "ERP", URL: "https://erp.example.com", Authentication: "BasicAuthentication", User: "u", Password: "p" }]));
    const t = await resolveODataTarget(config, { destination: "ERP", servicePath: "/sap/opu/odata/sap/SEPMRA_PROD_MAN" }, 5000);
    expect(t.url).toBe("https://erp.example.com/sap/opu/odata/sap/SEPMRA_PROD_MAN");
    expect(t.headers.authorization).toMatch(/^Basic /);
    expect(t.source).toBe("destination:ERP");
  });

  it("falls back to configured SAP systems and plain URLs", async () => {
    vi.stubEnv("SAP_BASE_URL", "https://abap.example.com");
    vi.stubEnv("SAP_SYSTEM_NAME", "abap");
    const cfg = loadConfig(["--port", "3999"]);
    cfg.logLevel = "off";
    const t1 = await resolveODataTarget(cfg, { systemName: "abap", servicePath: "/sap/opu/odata/sap/X" }, 5000);
    expect(t1.url).toBe("https://abap.example.com/sap/opu/odata/sap/X");
    const t2 = await resolveODataTarget(cfg, { serviceUrl: "https://plain.example.com/svc/" }, 5000);
    expect(t2.url).toBe("https://plain.example.com/svc/");
  });
});

describe("query_odata_data tool round trip", () => {
  it("queries an entity set through a destination", async () => {
    vi.stubEnv("SAP_DESTINATIONS_JSON", JSON.stringify([{ Name: "ERP", URL: "https://erp.example.com", Authentication: "BasicAuthentication", User: "u", Password: "p" }]));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        const u = String(url);
        expect(u).toContain("https://erp.example.com/Travel");
        expect(u).toContain("%24filter=");
        expect(u).toContain("%24top=10");
        return jsonResponse({ value: [{ ID: "1", Status: "A" }, { ID: "2", Status: "A" }] });
      })
    );
    const server = createMcpServer(config);
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [c, s] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(s), client.connect(c)]);
    const res = await client.callTool({
      name: "query_odata_data",
      arguments: { entitySet: "Travel", destination: "ERP", filter: "Status eq 'A'", top: 10 }
    });
    expect(res.isError).toBeFalsy();
    const data = JSON.parse((res.content as { type: string; text: string }[])[0].text);
    expect(data.count).toBe(2);
    expect(data.hasMore).toBe(false);
    expect(data.source).toBe("destination:ERP");
    await client.close();
    await server.close();
  });
});

describe("Floorplan templates", () => {
  const base = {
    namespace: "ns",
    appId: "ns.travel",
    appName: "travel",
    title: "Travel",
    entitySet: "Travel",
    mainEntity: "Travel",
    odataVersion: "4.0" as const,
    serviceUri: "/odata/v4/travel/"
  };

  it("object-page manifest uses the ObjectPage root view (V4)", () => {
    const m = feManifest({ ...base, addFcl: false, floorplan: "object-page" });
    const parsed = JSON.parse(m);
    expect(parsed["sap.ui5"].rootView.viewName).toBe("sap.fe.templates.ObjectPage.view.ObjectPage");
    const target = parsed["sap.ui5"].routing.targets.TravelObjectPage;
    expect(target.name).toBe("sap.fe.templates.ObjectPage");
    expect(parsed["sap.app"].sourceTemplate.id).toContain("object-page");
  });

  it("worklist manifest defaults initialLoad to true", () => {
    const parsed = JSON.parse(feManifest({ ...base, addFcl: false, floorplan: "worklist" }));
    expect(parsed["sap.ui5"].routing.targets.TravelList.options.settings.initialLoad).toBe(true);
    expect(parsed["sap.ui5"].routing.targets.TravelObjectPage).toBeDefined();
  });

  it("overview-page manifest (V2) contains sap.ovp cards", () => {
    const parsed = JSON.parse(feManifest({ ...base, odataVersion: "2.0", addFcl: false, floorplan: "overview-page" }));
    expect(parsed["sap.ovp"].cards.card00.template).toBe("sap.ovp.cards.list");
    expect(parsed["sap.ovp"].cards.card00.settings.entitySet).toBe("Travel");
    expect(parsed["sap.ui5"].rootView.viewName).toBe("sap.ovp.app.Main");
  });

  it("analytical-list-page manifest (V2) uses the generic template ALP component", () => {
    const parsed = JSON.parse(feManifest({ ...base, odataVersion: "2.0", addFcl: false, floorplan: "analytical-list-page" }));
    expect(parsed["sap.ui5"].routing.targets.TravelList.name).toBe("sap.suite.ui.generic.template.AnalyticalListPage");
    expect(parsed["sap.ui5"].routing.targets.TravelObjectPage.name).toBe("sap.suite.ui.generic.template.ObjectPage");
  });

  it("downgrades unsupported floorplan/version combos with a warning", () => {
    const warnings: string[] = [];
    expect(resolveFloorplan("object-page", "2.0", warnings)).toBe("list-report");
    expect(resolveFloorplan("overview-page", "4.0", warnings)).toBe("list-report");
    expect(resolveFloorplan("analytical-list-page", "4.0", warnings)).toBe("list-report");
    expect(warnings.length).toBe(3);
    expect(resolveFloorplan("worklist", "4.0", [])).toBe("worklist");
  });
});

describe("UI5 freestyle templates fcl and tabs", () => {
  it("fcl template generates FCL routing and Master/Detail views", () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-fcl-"));
    const { appPath, files } = createUi5App(ws, { name: "shop", namespace: "ns", title: "Shop", template: "fcl", serviceUri: "/odata/v2/" });
    const manifest = JSON.parse(fs.readFileSync(path.join(appPath, "webapp", "manifest.json"), "utf8"));
    expect(manifest["sap.ui5"].routing.config.routerClass).toBe("sap.f.routing.Router");
    expect(manifest["sap.ui5"].routing.config.controlAggregation).toBe("beginColumnPages");
    expect(manifest["sap.ui5"].dependencies.libs["sap.f"]).toBeDefined();
    const created = files.map((f) => f.split(path.sep).join("/"));
    expect(created.some((f) => f.endsWith("view/Master.view.xml"))).toBe(true);
    expect(created.some((f) => f.endsWith("view/Detail.view.xml"))).toBe(true);
    fs.rmSync(ws, { recursive: true, force: true });
  });

  it("tabs template generates an IconTabBar page", () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-tabs-"));
    const { appPath } = createUi5App(ws, { name: "portal", namespace: "ns", title: "Portal", template: "tabs" });
    const view = fs.readFileSync(path.join(appPath, "webapp", "view", "Main.view.xml"), "utf8");
    expect(view).toContain("IconTabBar");
    const manifest = JSON.parse(fs.readFileSync(path.join(appPath, "webapp", "manifest.json"), "utf8"));
    expect(manifest["sap.app"].dataSources).toBeUndefined(); // tabs is static, no OData source
    fs.rmSync(ws, { recursive: true, force: true });
  });
});
