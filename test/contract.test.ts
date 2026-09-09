import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig, type AppConfig } from "../src/config.js";
import { createMcpServer, toolNamer } from "../src/server.js";
import { assertUrlAllowed, BlockedHostError } from "../src/net/guard.js";
import { isOriginAllowed } from "../src/http.js";
import { paginate } from "../src/tools/index.js";
import { normalizeDestination } from "../src/btp/destinations.js";
import { EXAMPLE_ROOT } from "./example-root.js";

let config: AppConfig;

beforeAll(() => {
  config = loadConfig([]);
  config.workspaceRoot = EXAMPLE_ROOT;
  config.logLevel = "off";
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function connect(cfg: AppConfig = config) {
  const server = createMcpServer(cfg);
  const client = new Client({ name: "contract-test", version: "1.0.0" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);
  return { server, client, close: async () => { await client.close(); await server.close(); } };
}

describe("server identity", () => {
  it("keeps SERVER_VERSION in sync with package.json", () => {
    const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string; name: string };
    expect(config.serverVersion).toBe(pkg.version);
    expect(config.serverName).toBe(pkg.name);
  });
});

describe("tool contract", () => {
  it("every tool declares a description, an output schema and behaviour annotations", async () => {
    const { client, close } = await connect();
    const { tools } = await client.listTools();

    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(tool.description, `${tool.name} has no description`).toBeTruthy();
      expect(tool.outputSchema, `${tool.name} has no outputSchema`).toBeDefined();
      expect(tool.annotations, `${tool.name} has no annotations`).toBeDefined();
      expect(typeof tool.annotations?.readOnlyHint, `${tool.name} readOnlyHint`).toBe("boolean");
      expect(typeof tool.annotations?.destructiveHint, `${tool.name} destructiveHint`).toBe("boolean");
      expect(typeof tool.annotations?.idempotentHint, `${tool.name} idempotentHint`).toBe("boolean");
      expect(typeof tool.annotations?.openWorldHint, `${tool.name} openWorldHint`).toBe("boolean");
      // a read-only tool must never be flagged destructive
      if (tool.annotations?.readOnlyHint) expect(tool.annotations.destructiveHint).toBe(false);
    }
    await close();
  });

  it("scaffolding tools are the ones marked as writing", async () => {
    const { client, close } = await connect();
    const { tools } = await client.listTools();
    const writing = tools.filter((t) => !t.annotations?.readOnlyHint).map((t) => t.name).sort();
    expect(writing).toEqual(
      [
        "create_integration_card",
        "create_ui5_app",
        "download_odata_service_metadata",
        "execute_functionality",
        "generate_fiori_app_cap",
        "generate_fiori_app_odata"
      ].sort()
    );
    await close();
  });

  // Every local read-only tool, called with arguments that must succeed against the bundled
  // example. structuredContent is returned only when it validates against the declared
  // outputSchema, so a present structuredContent proves the schema and the handler agree.
  const localReadCalls: { name: string; args: Record<string, unknown> }[] = [
    { name: "search_docs", args: { query: "list report" } },
    { name: "get_guidelines", args: { topic: "routing" } },
    { name: "get_integration_cards_guidelines", args: {} },
    { name: "get_typescript_conversion_guidelines", args: {} },
    { name: "list_fiori_apps", args: {} },
    { name: "list_sap_systems", args: {} },
    { name: "search_model", args: { query: "Books" } },
    { name: "get_cap_details", args: { definitionName: "Books" } },
    { name: "query_cap_data", args: { entityName: "Books", limit: 2 } },
    { name: "get_project_info", args: {} },
    { name: "list_btp_destinations", args: { includeDestinationService: false } }
  ];

  it.each(localReadCalls)("$name returns structuredContent matching its output schema", async ({ name, args }) => {
    const { client, close } = await connect();
    const res = await client.callTool({ name, arguments: args });
    expect(res.isError, `${name} failed: ${JSON.stringify(res.content)}`).toBeFalsy();
    expect(res.structuredContent, `${name} returned no structuredContent`).toBeDefined();
    // the text block mirrors the structured payload for clients that only read text
    const text = JSON.parse((res.content as { type: string; text: string }[])[0].text);
    expect(text).toEqual(res.structuredContent);
    await close();
  });

  it("scaffolding tools validate against their output schema too", async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-contract-"));
    const { client, close } = await connect();

    const app = await client.callTool({
      name: "create_ui5_app",
      arguments: { targetPath: ws, name: "demo", title: "Demo", template: "basic" }
    });
    expect(app.isError).toBeFalsy();
    expect(app.structuredContent).toBeDefined();
    const created = (app.structuredContent as { createdFiles: string[] }).createdFiles;
    expect(created).toContain("demo/webapp/manifest.json");
    // paths are reported with forward slashes on every platform
    expect(created.every((f) => !f.includes("\\"))).toBe(true);

    const validation = await client.callTool({
      name: "run_manifest_validation",
      arguments: { appPath: path.join(ws, "demo") }
    });
    expect(validation.isError).toBeFalsy();
    expect((validation.structuredContent as { valid: boolean }).valid).toBe(true);

    await close();
    fs.rmSync(ws, { recursive: true, force: true });
  });

  it("reports a missing definition as a tool error with a usable hint", async () => {
    const { client, close } = await connect();
    const res = await client.callTool({ name: "get_cap_details", arguments: { definitionName: "DoesNotExist" } });
    expect(res.isError).toBe(true);
    expect((res.content as { text: string }[])[0].text).toContain("not found");
    await close();
  });
});

// Regression: view names in a manifest are fully qualified with the app id, which maps to
// webapp/. Resolving them without stripping that prefix reported a missing file for every app.
describe("run_manifest_validation against generated apps", () => {
  const ui5Templates = ["basic", "worklist", "master-detail", "fcl", "tabs"] as const;

  it.each(ui5Templates)("accepts the '%s' freestyle template it just scaffolded", async (template) => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-validate-"));
    const { client, close } = await connect();
    const app = await client.callTool({
      name: "create_ui5_app",
      arguments: { targetPath: ws, name: "demo", namespace: "ns", title: "Demo", template, serviceUri: "/odata/v2/" }
    });
    const appPath = (app.structuredContent as { appPath: string }).appPath;
    const result = (await client.callTool({ name: "run_manifest_validation", arguments: { appPath } }))
      .structuredContent as { valid: boolean; issues: { message: string }[] };
    expect(result.issues.filter((i) => i.message.includes("not found on disk"))).toEqual([]);
    expect(result.valid, JSON.stringify(result.issues)).toBe(true);
    await close();
    fs.rmSync(ws, { recursive: true, force: true });
  });

  it.each(["list-report", "worklist", "object-page"] as const)("accepts the '%s' Fiori elements floorplan", async (floorplan) => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-validate-fe-"));
    const { client, close } = await connect();
    const app = await client.callTool({
      name: "generate_fiori_app_odata",
      arguments: { workspacePath: ws, appName: "travels", title: "Travels", entitySet: "Travel", floorplan }
    });
    expect(app.isError).toBeFalsy();
    const appPath = (app.structuredContent as { appPath: string }).appPath;
    const result = (await client.callTool({ name: "run_manifest_validation", arguments: { appPath } }))
      .structuredContent as { valid: boolean; issues: { message: string }[] };
    expect(result.valid, JSON.stringify(result.issues)).toBe(true);
    await close();
    fs.rmSync(ws, { recursive: true, force: true });
  });
});

describe("pagination", () => {
  it("reports the page window and where to continue", () => {
    const items = [1, 2, 3, 4, 5];
    const first = paginate(items, 2, 0);
    expect(first).toMatchObject({ count: 2, total: 5, offset: 0, hasMore: true, nextOffset: 2 });
    const last = paginate(items, 2, 4);
    expect(last).toMatchObject({ count: 1, total: 5, offset: 4, hasMore: false, nextOffset: null });
    expect(paginate(items, 10, 99)).toMatchObject({ count: 0, hasMore: false, nextOffset: null });
  });

  it("search_docs pages through the corpus without losing the total", async () => {
    const { client, close } = await connect();
    const first = (await client.callTool({ name: "search_docs", arguments: { query: "annotation", limit: 2 } }))
      .structuredContent as { total: number; count: number; hasMore: boolean; nextOffset: number | null; results: { id: string }[] };
    expect(first.count).toBe(2);
    expect(first.total).toBeGreaterThan(2);
    expect(first.hasMore).toBe(true);

    const second = (await client.callTool({ name: "search_docs", arguments: { query: "annotation", limit: 2, offset: first.nextOffset! } }))
      .structuredContent as { total: number; results: { id: string }[] };
    expect(second.total).toBe(first.total);
    expect(second.results[0].id).not.toBe(first.results[0].id);
    await close();
  });

  it("query_cap_data separates rows returned from rows matched", async () => {
    const { client, close } = await connect();
    const page = (await client.callTool({ name: "query_cap_data", arguments: { entityName: "Books", limit: 1 } }))
      .structuredContent as { count: number; total: number; hasMore: boolean; nextSkip: number | null };
    expect(page.count).toBe(1);
    expect(page.total).toBeGreaterThan(1);
    expect(page.hasMore).toBe(true);
    expect(page.nextSkip).toBe(1);
    await close();
  });
});

describe("outbound host allowlist", () => {
  const withDomains = (domains: string[]): AppConfig => ({ ...config, allowedDomains: domains, sapSystems: [] });

  it("allows everything when no allowlist is configured", () => {
    expect(() => assertUrlAllowed({ ...config, allowedDomains: [] }, "https://any.example.com/srv")).not.toThrow();
  });

  it("rejects non-http protocols regardless of the allowlist", () => {
    expect(() => assertUrlAllowed({ ...config, allowedDomains: [] }, "file:///etc/passwd")).toThrow(/Unsupported protocol/);
    expect(() => assertUrlAllowed({ ...config, allowedDomains: [] }, "not a url")).toThrow(/Invalid URL/);
  });

  it("enforces exact hosts and wildcard subdomains once configured", () => {
    const cfg = withDomains(["localhost", "*.sap-system.example"]);
    expect(() => assertUrlAllowed(cfg, "http://localhost:4004/odata/v4/catalog/")).not.toThrow();
    expect(() => assertUrlAllowed(cfg, "https://s4.sap-system.example/sap/opu/odata/sap/SRV")).not.toThrow();
    expect(() => assertUrlAllowed(cfg, "https://sap-system.example/srv")).not.toThrow();
    expect(() => assertUrlAllowed(cfg, "https://attacker.example/srv")).toThrow(BlockedHostError);
  });

  it("trusts a destination's own host even when it is not on the allowlist", async () => {
    const { resolveODataTarget } = await import("../src/btp/destinations.js");
    vi.stubEnv("SAP_DESTINATIONS_JSON", JSON.stringify([{ Name: "ERP", URL: "https://erp.corp.example", Authentication: "NoAuthentication" }]));
    const cfg: AppConfig = { ...config, allowedDomains: ["localhost"], sapSystems: [] };
    const target = await resolveODataTarget(cfg, { destination: "ERP", servicePath: "/sap/opu/odata/sap/SRV" });
    expect(target.trustedUrls).toContain("https://erp.corp.example");
    expect(() => assertUrlAllowed(cfg, target.url, target.trustedUrls)).not.toThrow();
    // the same host is still blocked when it arrives as a raw tool argument
    expect(() => assertUrlAllowed(cfg, "https://erp.corp.example/other")).toThrow(BlockedHostError);
  });

  it("always trusts hosts named by the server's own configuration", () => {
    const cfg: AppConfig = {
      ...config,
      allowedDomains: ["localhost"],
      sapSystems: [{ name: "erp", url: "https://erp.internal:44300", authType: "none" }]
    };
    expect(() => assertUrlAllowed(cfg, "https://erp.internal:44300/sap/opu/odata/sap/SRV")).not.toThrow();
    expect(() => assertUrlAllowed(cfg, "https://other.internal/sap")).toThrow(BlockedHostError);
  });
});

describe("HTTP transport origin check", () => {
  it("accepts requests without an Origin header (non-browser clients)", () => {
    expect(isOriginAllowed(undefined, config)).toBe(true);
  });

  it("accepts loopback origins and rejects remote ones by default", () => {
    expect(isOriginAllowed("http://localhost:5173", config)).toBe(true);
    expect(isOriginAllowed("http://127.0.0.1:3000", config)).toBe(true);
    expect(isOriginAllowed("https://evil.example", config)).toBe(false);
  });

  it("honours SAP_FIORI_MCP_ALLOWED_ORIGINS", () => {
    expect(isOriginAllowed("https://team.example", { ...config, allowedOrigins: ["https://team.example"] })).toBe(true);
    expect(isOriginAllowed("https://anything.example", { ...config, allowedOrigins: ["*"] })).toBe(true);
  });
});

describe("tool name prefix", () => {
  it("is a no-op by default", () => {
    expect(toolNamer(config)("search_docs")).toBe("search_docs");
  });

  it("prefixes every registered tool when configured", async () => {
    const prefixed = { ...config, toolPrefix: "sapfiori" };
    expect(toolNamer(prefixed)("search_docs")).toBe("sapfiori_search_docs");
    const { client, close } = await connect(prefixed);
    const { tools } = await client.listTools();
    expect(tools.every((t) => t.name.startsWith("sapfiori_"))).toBe(true);
    await close();
  });
});

describe("destination env fallbacks", () => {
  it("picks up BTP_USER_TOKEN when the destination does not carry one", () => {
    vi.stubEnv("BTP_USER_TOKEN", "jwt-from-env");
    const d = normalizeDestination({ Name: "SF", URL: "https://sf.example", Authentication: "OAuth2JWTBearer" }, "env");
    expect(d.userToken).toBe("jwt-from-env");
  });

  it("prefers an explicit userToken over the env var", () => {
    vi.stubEnv("BTP_USER_TOKEN", "jwt-from-env");
    const d = normalizeDestination({ name: "SF", url: "https://sf.example", authType: "OAuth2JWTBearer", userToken: "explicit" }, "env");
    expect(d.userToken).toBe("explicit");
  });
});

// PowerShell 5.1 and Notepad both write a UTF-8 BOM, so a hand-written config file on Windows
// starts with one. JSON.parse rejects it, and the failure used to be swallowed: the server
// reported "no systems configured" with nothing pointing at the real cause.
describe("configuration files written on Windows", () => {
  const withSystemsFile = (contents: string | Buffer) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-cfg-"));
    const file = path.join(dir, "systems.json");
    fs.writeFileSync(file, contents);
    vi.stubEnv("SAP_SYSTEMS_FILE", file);
    return { dir, file };
  };
  const systems = [{ name: "ERP", url: "https://erp.example:44300", client: "810", user: "G1", password: "s3cr3t" }];

  it("loads a systems.json that starts with a BOM", () => {
    const { dir } = withSystemsFile(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify(systems), "utf8")]));
    const cfg = loadConfig([]);
    expect(cfg.sapSystems.map((s) => s.name)).toContain("ERP");
    expect(cfg.configWarnings).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("still loads a plain UTF-8 file", () => {
    const { dir } = withSystemsFile(JSON.stringify({ systems }));
    expect(loadConfig([]).sapSystems.map((s) => s.name)).toContain("ERP");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reports a malformed file instead of silently finding no systems", async () => {
    const { dir, file } = withSystemsFile("{ this is not json");
    const cfg = loadConfig([]);
    expect(cfg.sapSystems).toEqual([]);
    expect(cfg.configWarnings.join(" ")).toContain(file);

    const { client, close } = await connect({ ...cfg, workspaceRoot: EXAMPLE_ROOT, logLevel: "off" });
    const res = (await client.callTool({ name: "list_sap_systems", arguments: {} })).structuredContent as {
      count: number;
      warnings?: string[];
      hint: string;
    };
    expect(res.count).toBe(0);
    expect(res.warnings?.join(" ")).toContain("could not be read as JSON");
    expect(res.hint).toContain("could not be used");
    await close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("never invents a password: secrets stay out of the tool output", async () => {
    const { dir } = withSystemsFile(JSON.stringify(systems));
    const cfg = loadConfig([]);
    const { client, close } = await connect({ ...cfg, workspaceRoot: EXAMPLE_ROOT, logLevel: "off" });
    const res = await client.callTool({ name: "list_sap_systems", arguments: {} });
    expect(JSON.stringify(res)).not.toContain("s3cr3t");
    await close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// A config file with a plain-text password has to be guarded like a secret. ${env:NAME} keeps the
// value in the environment, and is the convention the surrounding SAP tooling already uses.
describe("${env:NAME} references in configuration", () => {
  const writeSystems = (systems: unknown) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-envref-"));
    const file = path.join(dir, "systems.json");
    fs.writeFileSync(file, JSON.stringify(systems), "utf8");
    vi.stubEnv("SAP_SYSTEMS_FILE", file);
    return { dir, file };
  };

  it("resolves a password held in an environment variable", () => {
    vi.stubEnv("TEST_A4H_PW", "from-the-environment");
    vi.stubEnv("TEST_A4H_USER", "DEVELOPER");
    const { dir } = writeSystems([
      { name: "A4H", url: "https://host:44301", client: "100", user: "${env:TEST_A4H_USER}", password: "${env:TEST_A4H_PW}" }
    ]);
    const cfg = loadConfig([]);
    const a4h = cfg.sapSystems.find((s) => s.name === "A4H")!;
    expect(a4h.user).toBe("DEVELOPER");
    expect(a4h.password).toBe("from-the-environment");
    expect(cfg.configWarnings).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("warns instead of authenticating with an empty password when the variable is unset", async () => {
    const { dir, file } = writeSystems([
      { name: "A4H", url: "https://host:44301", client: "100", user: "DEVELOPER", password: "${env:TEST_UNSET_PW}" }
    ]);
    const cfg = loadConfig([]);
    expect(cfg.sapSystems[0].password).toBe("");
    expect(cfg.configWarnings.join(" ")).toContain("TEST_UNSET_PW");
    expect(cfg.configWarnings.join(" ")).toContain(file);

    const { client, close } = await connect({ ...cfg, workspaceRoot: EXAMPLE_ROOT, logLevel: "off" });
    const res = (await client.callTool({ name: "list_sap_systems", arguments: {} })).structuredContent as { warnings?: string[] };
    expect(res.warnings?.join(" ")).toContain("TEST_UNSET_PW");
    await close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("leaves ordinary values untouched", () => {
    const { dir } = writeSystems([{ name: "PLAIN", url: "https://host:44300", client: "001", user: "u", password: "literal" }]);
    expect(loadConfig([]).sapSystems[0].password).toBe("literal");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
