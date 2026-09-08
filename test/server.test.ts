import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig, type AppConfig } from "../src/config.js";
import { createMcpServer } from "../src/server.js";
import { buildCdsModel, searchModel, getServiceExposure, resolveEntityCsv, getDefinitionDetails } from "../src/cap/model.js";
import { generateFioriApp } from "../src/fiori/generate.js";
import { EXAMPLE_ROOT } from "./example-root.js";

let config: AppConfig;

beforeAll(() => {
  config = loadConfig(["--port", "3999"]);
  config.workspaceRoot = EXAMPLE_ROOT;
  config.logLevel = "off";
});

describe("createMcpServer", () => {
  it("exposes all 26 tools over an in-memory transport", async () => {
    const server = createMcpServer(config);
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();

    const expected = [
      "search_docs", "get_guidelines", "get_integration_cards_guidelines", "get_typescript_conversion_guidelines",
      "list_fiori_apps", "list_sap_systems", "download_odata_service_metadata",
      "generate_fiori_app_odata", "generate_fiori_app_cap",
      "list_functionality", "get_functionality_details", "execute_functionality", "get_metadata_summary",
      "create_ui5_app", "create_integration_card", "get_api_reference", "get_project_info", "get_version_info",
      "run_manifest_validation", "run_ui5_linter",
      "search_model", "get_cap_details", "query_cap_data",
      "list_btp_destinations", "get_btp_destination", "query_odata_data"
    ].sort();
    for (const name of expected) {
      expect(names).toContain(name);
    }
    expect(tools.length).toBeGreaterThanOrEqual(expected.length);
    await client.close();
    await server.close();
  });

  it("search_docs tool returns results", async () => {
    const server = createMcpServer(config);
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [c, s] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(s), client.connect(c)]);

    const res = await client.callTool({ name: "search_docs", arguments: { query: "list report initial load" } });
    expect(res.isError).toBeFalsy();
    const data = JSON.parse((res.content as { type: string; text: string }[])[0].text);
    expect(data.results.length).toBeGreaterThan(0);
    expect(JSON.stringify(data.results)).toContain("initialLoad");
    await client.close();
    await server.close();
  });

  it("run_manifest_validation works end-to-end on generated app", async () => {
    // generate a real app into the examples folder
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-e2e-"));
    const server = createMcpServer(config);
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [c, s] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(s), client.connect(c)]);

    const gen = await client.callTool({
      name: "generate_fiori_app_odata",
      arguments: { workspacePath: ws, appName: "e2eapp", title: "E2E", entitySet: "Travel", serviceUrl: "/odata/v4/travel/", odataVersion: "4.0" }
    });
    expect(gen.isError).toBeFalsy();
    const genData = JSON.parse((gen.content as { type: string; text: string }[])[0].text);
    const appPath = genData.appPath as string;

    const val = await client.callTool({ name: "run_manifest_validation", arguments: { appPath } });
    const valData = JSON.parse((val.content as { type: string; text: string }[])[0].text);
    expect(valData.errors).toBe(0);

    const lint = await client.callTool({ name: "run_ui5_linter", arguments: { projectPath: appPath } });
    expect(lint.isError).toBeFalsy();
    fs.rmSync(ws, { recursive: true, force: true });
    await client.close();
    await server.close();
  });
});

describe("CAP model against example project", () => {
  it("builds model from the bookshop example", () => {
    const model = buildCdsModel(EXAMPLE_ROOT);
    expect(model.namespaces).toContain("sap.demo.bookshop");
    expect(model.definitions.find((d) => d.name === "sap.demo.bookshop.Books")).toBeDefined();
    expect(model.definitions.find((d) => d.name === "CatalogService.Books")).toBeDefined();
  });

  it("searches and resolves exposure", () => {
    const model = buildCdsModel(EXAMPLE_ROOT);
    const hits = searchModel(model, "Books", { kind: "entity" });
    expect(hits.length).toBeGreaterThan(0);
    const exposure = getServiceExposure(model);
    const cat = exposure.find((e) => e.service.endsWith("CatalogService"));
    expect(cat?.exposed.map((x) => x.name)).toContain("Books");
  });

  it("resolves CSV data and gets details", () => {
    const csv = resolveEntityCsv(EXAMPLE_ROOT, "Books");
    expect(csv).toBeTruthy();
    expect(fs.readFileSync(csv!, "utf8")).toContain("title");
    const details = getDefinitionDetails(buildCdsModel(EXAMPLE_ROOT), "Books");
    expect(details).not.toBeNull();
    expect((details!.elements as unknown[]).length).toBeGreaterThan(2);
  });
});

describe("query_cap_data tool", () => {
  it("queries the Books CSV", async () => {
    const server = createMcpServer(config);
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [c, s] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(s), client.connect(c)]);
    const res = await client.callTool({
      name: "query_cap_data",
      arguments: { projectPath: EXAMPLE_ROOT, entityName: "Books", filter: "stock > 0", limit: 10 }
    });
    expect(res.isError).toBeFalsy();
    const data = JSON.parse((res.content as { type: string; text: string }[])[0].text);
    expect(data.count).toBeGreaterThan(0);
    await client.close();
    await server.close();
  });
});

describe("generate_fiori_app_cap tool", () => {
  it("generates an app inside the bookshop example", async () => {
    const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), "cap-gen-"));
    // copy example structure (db/srv/package.json) into temp so we don't pollute the example
    fs.cpSync(EXAMPLE_ROOT, tmpWs, { recursive: true });

    const server = createMcpServer(config);
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [c, s] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(s), client.connect(c)]);
    const res = await client.callTool({
      name: "generate_fiori_app_cap",
      arguments: { capProjectPath: tmpWs, appName: "bookshop-books", title: "Books" }
    });
    expect(res.isError).toBeFalsy();
    const data = JSON.parse((res.content as { type: string; text: string }[])[0].text);
    expect(data.resolvedEntitySet).toBe("Books");
    expect(fs.existsSync(path.join(data.appPath, "webapp", "manifest.json"))).toBe(true);
    fs.rmSync(tmpWs, { recursive: true, force: true });
    await client.close();
    await server.close();
  });
});

describe("generateFioriApp direct", () => {
  it("also works programmatically", async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "direct-gen-"));
    const r = await generateFioriApp({
      targetPath: ws,
      appName: "direct",
      title: "Direct",
      entitySet: "Books",
      serviceUrl: "/odata/v4/catalog/",
      odataVersion: "4.0",
      floorplan: "list-report",
      isCap: true
    });
    expect(fs.existsSync(path.join(r.appPath, "ui5.yaml"))).toBe(true);
    fs.rmSync(ws, { recursive: true, force: true });
  });
});
