import { describe, it, expect, beforeAll, afterAll, vi, afterEach } from "vitest";
import { resolveODataUrl } from "../src/btp/destinations.js";
import { loadConfig } from "../src/config.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listFioriApps, summarizeApp, readAppManifest, isCapProject } from "../src/fiori/apps.js";
import { validateManifest } from "../src/ui5/validate.js";
import { runUi5Linter } from "../src/ui5/linter.js";
import { generateFioriApp, pickMainEntitySet } from "../src/fiori/generate.js";
import { parseEdmx } from "../src/odata/edmx.js";
import { createUi5App, createIntegrationCard } from "../src/ui5/scaffold.js";
import {
  listFunctionalities,
  getFunctionalityDetails,
  executeFunctionality
} from "../src/fiori/functionality.js";

let tmp: string;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fiori-mcp-test-"));
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeManifest(appRel: string, manifest: Record<string, unknown>): string {
  const appDir = path.join(tmp, appRel);
  fs.mkdirSync(path.join(appDir, "webapp"), { recursive: true });
  fs.writeFileSync(path.join(appDir, "webapp", "manifest.json"), JSON.stringify(manifest, null, 2));
  return appDir;
}

const FE_MANIFEST = {
  "sap.app": {
    id: "ns.demo.app",
    type: "application",
    title: "Demo",
    dataSources: { mainService: { uri: "/odata/v4/travel/", type: "OData", settings: { odataVersion: "4.0" } } }
  },
  "sap.ui5": {
    dependencies: { minUI5Version: "1.130.0", libs: { "sap.m": {}, "sap.fe.templates": {} } },
    models: { i18n: { type: "sap.ui.model.resource.ResourceModel", settings: { bundleName: "ns.demo.app.i18n.i18n" } } },
    routing: {
      config: { routerClass: "sap.m.routing.Router", viewPath: "ns.demo.app.view" },
      routes: [{ pattern: ":?query:", name: "TravelList", target: "TravelList" }],
      targets: {
        TravelList: {
          type: "Component",
          id: "TravelList",
          name: "sap.fe.templates.ListReport",
          options: { settings: { entitySet: "Travel", initialLoad: false } }
        }
      }
    }
  }
};

describe("listFioriApps / summarizeApp", () => {
  it("finds a FE v4 app and extracts metadata", () => {
    const appDir = writeManifest("projects/workspace/app/travels", FE_MANIFEST);
    const ws = path.join(tmp, "projects", "workspace");
    const result = listFioriApps(ws);
    expect(result.apps).toHaveLength(1);
    expect(result.apps[0].appId).toBe("ns.demo.app");
    expect(result.apps[0].type).toBe("fiori-elements-v4");
    expect(result.apps[0].entitySet).toBe("Travel");
    // app paths are reported with forward slashes on every platform
    expect(result.apps[0].path).toBe(path.relative(ws, appDir).split(path.sep).join("/"));
    expect(isCapProject(ws)).toBe(false);
  });

  it("summarizeApp detects cards", () => {
    const appDir = writeManifest("cards/mycard", { "sap.app": { id: "ns.card", type: "card" }, "sap.card": { type: "List" } });
    const s = summarizeApp(appDir, "mycard");
    expect(s?.type).toBe("card");
    expect(readAppManifest(appDir)).not.toBeNull();
  });
});

describe("validateManifest", () => {
  it("valid FE v4 manifest passes", () => {
    const appDir = writeManifest("val/valid", FE_MANIFEST);
    fs.mkdirSync(path.join(appDir, "webapp", "i18n"), { recursive: true });
    fs.writeFileSync(path.join(appDir, "webapp", "i18n", "i18n.properties"), "appTitle=Demo\n");
    const r = validateManifest(appDir);
    expect(r.errors).toBe(0);
    expect(r.valid).toBe(true);
  });

  it("invalid id and missing target fail", () => {
    const appDir = writeManifest("val/invalid", {
      "sap.app": { id: "1bad_id", type: "application" },
      "sap.ui5": {
        dependencies: { minUI5Version: "bad" },
        models: { "": { dataSource: "missingDs" } },
        routing: {
          routes: [{ pattern: "", name: "x", target: "nope" }],
          targets: { x: { viewName: "NoSuchView", viewId: "x" } }
        }
      }
    });
    const r = validateManifest(appDir);
    expect(r.valid).toBe(false);
    expect(r.issues.some((i) => i.rule === "sap.app.id.first-char" || i.rule === "sap.app.id.pattern")).toBe(true);
    expect(r.issues.some((i) => i.rule === "routing.target.missing")).toBe(true);
    expect(r.issues.some((i) => i.rule === "models.dataSource.missing")).toBe(true);
    expect(r.issues.some((i) => i.rule === "view.file.missing")).toBe(true);
    expect(r.issues.some((i) => i.rule === "dependencies.minUI5Version.format")).toBe(true);
  });
});

describe("runUi5Linter", () => {
  it("detects deprecated APIs and missing i18n keys", () => {
    const appDir = path.join(tmp, "lint", "app");
    fs.mkdirSync(path.join(appDir, "webapp", "controller"), { recursive: true });
    fs.mkdirSync(path.join(appDir, "webapp", "i18n"), { recursive: true });
    fs.mkdirSync(path.join(appDir, "webapp", "view"), { recursive: true });
    fs.writeFileSync(
      path.join(appDir, "webapp", "controller", "Main.controller.js"),
      `sap.ui.define(["sap/ui/core/mvc/Controller"], function (Controller) {
  return Controller.extend("x.Main", {
    onInit: function () {
      const id = sap.ui.getCore().byId("x");
      jQuery.sap.log.info("deprecated");
    }
  });
});`
    );
    fs.writeFileSync(
      path.join(appDir, "webapp", "view", "Main.view.xml"),
      `<mvc:View xmlns:mvc="sap.ui.core.mvc" xmlns="sap.m" controllerName="x.controller.Main"><Text text="{i18n>doesNotExist}"/></mvc:View>`
    );
    fs.writeFileSync(path.join(appDir, "webapp", "i18n", "i18n.properties"), "existing=yes\n");
    const { issues } = runUi5Linter(appDir);
    expect(issues.some((i) => i.rule === "api.deprecated.coreById")).toBe(true);
    expect(issues.some((i) => i.rule === "api.deprecated.jQuerySapLog")).toBe(true);
    expect(issues.some((i) => i.rule === "i18n.key.missing")).toBe(true);
  });
});

const TRAVEL_V4 = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="srv" Alias="SAP__self" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="BookingType"><Key><PropertyRef Name="BookingUuid"/></Key>
        <Property Name="BookingUuid" Type="Edm.Guid"/>
        <NavigationProperty Name="_Travel" Type="srv.TravelType"/>
      </EntityType>
      <EntityType Name="TravelType"><Key><PropertyRef Name="TravelUuid"/></Key>
        <Property Name="TravelUuid" Type="Edm.Guid"/>
        <NavigationProperty Name="_Booking" Type="Collection(srv.BookingType)"/>
      </EntityType>
      <EntityContainer Name="Container">
        <EntitySet Name="Booking" EntityType="srv.BookingType">
          <NavigationPropertyBinding Path="_Travel" Target="Travel"/>
        </EntitySet>
        <EntitySet Name="Travel" EntityType="srv.TravelType">
          <NavigationPropertyBinding Path="_Booking" Target="Booking"/>
        </EntitySet>
      </EntityContainer>
      <Annotations Target="SAP__self.BookingType"><Annotation Term="SAP__UI.LineItem"/></Annotations>
      <Annotations Target="SAP__self.TravelType"><Annotation Term="SAP__UI.LineItem"/></Annotations>
      <Annotations Target="SAP__self.Container/Booking"><Annotation Term="SAP__common.DraftNode"/></Annotations>
      <Annotations Target="SAP__self.Container/Travel"><Annotation Term="SAP__common.DraftRoot"/></Annotations>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

describe("choosing the entity set to build on", () => {
  it("prefers the draft root over an earlier listable child", () => {
    // the document lists Booking first, and both carry UI.LineItem under a service alias
    expect(pickMainEntitySet(parseEdmx(TRAVEL_V4))).toBe("Travel");
  });

  it("prefers a listable set over the first one in the document", () => {
    const xml = TRAVEL_V4.replace(/<Annotations Target="SAP__self.BookingType">[^]*?<\/Annotations>/, "")
      .replace(/<Annotations Target="SAP__self.Container\/Travel">[^]*?<\/Annotations>/, "");
    expect(pickMainEntitySet(parseEdmx(xml))).toBe("Travel");
  });

  it("says nothing when no set is annotated, leaving the caller its own default", () => {
    const xml = TRAVEL_V4.replace(/<Annotations[^]*?<\/Annotations>/g, "");
    expect(pickMainEntitySet(parseEdmx(xml))).toBeUndefined();
  });

  it("builds the app on the draft root when no entitySet is given", async () => {
    const ws = path.join(tmp, "gen-pick", "ws");
    fs.mkdirSync(ws, { recursive: true });
    const result = await generateFioriApp({
      targetPath: ws,
      appName: "travelpick",
      title: "Travel",
      metadataXml: TRAVEL_V4,
      serviceUrl: "/odata/v4/travel/",
      floorplan: "list-report",
      isCap: false
    });
    const manifest = JSON.parse(fs.readFileSync(path.join(result.appPath, "webapp", "manifest.json"), "utf8"));
    expect(Object.keys(manifest["sap.ui5"]["routing"]["targets"])).toContain("TravelList");
  });
});

describe("generateFioriApp", () => {
  it("generates a standalone FE v4 app from metadata", async () => {
    const ws = path.join(tmp, "gen", "ws");
    fs.mkdirSync(ws, { recursive: true });
    const result = await generateFioriApp({
      targetPath: ws,
      appName: "travels",
      title: "Travels",
      entitySet: "Travel",
      serviceUrl: "/odata/v4/travel/",
      odataVersion: "4.0",
      floorplan: "list-report",
      addFcl: true,
      isCap: false
    });
    expect(fs.existsSync(path.join(result.appPath, "webapp", "manifest.json"))).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(path.join(result.appPath, "webapp", "manifest.json"), "utf8"));
    expect(manifest["sap.app"]["id"]).toBe("ns.travels");
    expect(manifest["sap.ui5"]["routing"]["targets"]["TravelList"]["name"]).toBe("sap.fe.templates.ListReport");
    expect(manifest["sap.ui5"]["routing"]["targets"]["TravelObjectPage"]["name"]).toBe("sap.fe.templates.ObjectPage");
    expect(manifest["sap.ui5"]["routing"]["config"]["routerClass"]).toBe("sap.f.routing.Router");

    // refuse to overwrite
    await expect(
      generateFioriApp({ targetPath: ws, appName: "travels", title: "x", floorplan: "list-report", isCap: false })
    ).rejects.toThrow(/already exists/);
  });

  it("writes the service uri as a root, so its own validation raises nothing", async () => {
    const ws = path.join(tmp, "gen-slash", "ws");
    fs.mkdirSync(ws, { recursive: true });
    const result = await generateFioriApp({
      targetPath: ws,
      appName: "bookings",
      title: "Bookings",
      entitySet: "Booking",
      // a service path as it comes back from a catalog: no trailing slash
      serviceUrl: "https://abap.example.com/sap/opu/odata/sap/ZUI_FE_BOOKING_000110_O2",
      odataVersion: "2.0",
      floorplan: "list-report",
      isCap: false
    });
    const manifest = JSON.parse(fs.readFileSync(path.join(result.appPath, "webapp", "manifest.json"), "utf8"));
    expect(manifest["sap.app"]["dataSources"]["mainService"]["uri"]).toBe(
      "https://abap.example.com/sap/opu/odata/sap/ZUI_FE_BOOKING_000110_O2/"
    );
    const check = await validateManifest(result.appPath);
    expect(check.issues).toEqual([]);
  });

  it("writes an app id the manifest validation accepts, whatever the app is called", async () => {
    const ws = path.join(tmp, "gen-dashes", "ws");
    fs.mkdirSync(ws, { recursive: true });
    // a folder may carry a hyphen; a UI5 component id may not
    const result = await generateFioriApp({
      targetPath: ws,
      appName: "travel-lr_v2",
      title: "Travel",
      entitySet: "Travel",
      serviceUrl: "/odata/v4/travel/",
      odataVersion: "4.0",
      floorplan: "list-report",
      isCap: false
    });
    const manifest = JSON.parse(fs.readFileSync(path.join(result.appPath, "webapp", "manifest.json"), "utf8"));
    expect(manifest["sap.app"]["id"]).toBe("ns.travellrv2");
    const check = await validateManifest(result.appPath);
    expect(check.issues).toEqual([]);
    expect(check.valid).toBe(true);
  });
});

describe("createUi5App / createIntegrationCard", () => {
  it("creates worklist template", () => {
    const ws = path.join(tmp, "ui5", "ws");
    fs.mkdirSync(ws, { recursive: true });
    const { appPath } = createUi5App(ws, { name: "shop", namespace: "my.company", title: "Shop", template: "worklist", ui5Version: "1.120.0" });
    const manifest = JSON.parse(fs.readFileSync(path.join(appPath, "webapp", "manifest.json"), "utf8"));
    expect(manifest["sap.app"]["id"]).toBe("my.company.shop");
    expect(Object.keys(manifest["sap.ui5"]["routing"]["targets"])).toEqual(["worklist", "object"]);
    expect(fs.existsSync(path.join(appPath, "webapp", "view", "Worklist.view.xml"))).toBe(true);
  });

  it("creates a List integration card", () => {
    const ws = path.join(tmp, "cards", "ws");
    fs.mkdirSync(ws, { recursive: true });
    const { appPath } = createIntegrationCard(ws, { name: "products", cardType: "List", title: "Products" });
    const manifest = JSON.parse(fs.readFileSync(path.join(appPath, "webapp", "manifest.json"), "utf8"));
    expect(manifest["sap.app"]["type"]).toBe("card");
    expect(manifest["sap.card"]["type"]).toBe("List");
  });
});

describe("functionality workflow", () => {
  it("lists functionalities and enables initial load", () => {
    const appDir = writeManifest("fn/app", JSON.parse(JSON.stringify(FE_MANIFEST)));
    expect(listFunctionalities(appDir).map((f) => f.id)).toContain("add_page");
    const details = getFunctionalityDetails(appDir, "enable_initial_load");
    expect(details.id).toBe("enable_initial_load");

    const res = executeFunctionality(appDir, "enable_initial_load", {});
    expect(res.changed.length).toBe(1);
    const manifest = JSON.parse(fs.readFileSync(path.join(appDir, "webapp", "manifest.json"), "utf8"));
    expect(manifest["sap.ui5"]["routing"]["targets"]["TravelList"]["options"]["settings"]["initialLoad"]).toBe(true);
  });

  it("adds a freestyle page and then deletes it", () => {
    const appDir = writeManifest("fn/freestyle", {
      "sap.app": { id: "ns.fs", type: "application" },
      "sap.ui5": {
        rootView: { viewName: "ns.fs.view.App" },
        routing: { config: { viewPath: "ns.fs.view" }, routes: [], targets: {} }
      }
    });
    const res = executeFunctionality(appDir, "add_page", { viewName: "Details", routeName: "Details", pattern: "Details({ID}):?query:" });
    expect(res.created.length).toBe(2);
    expect(fs.existsSync(path.join(appDir, "webapp", "view", "Details.view.xml"))).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(path.join(appDir, "webapp", "manifest.json"), "utf8"));
    expect(manifest["sap.ui5"]["routing"]["routes"]).toHaveLength(1);

    executeFunctionality(appDir, "delete_page", { routeName: "Details", deleteViewFile: true });
    expect(fs.existsSync(path.join(appDir, "webapp", "view", "Details.view.xml"))).toBe(false);
  });

  it("enables FCL and updates manifest pointer", () => {
    const appDir = writeManifest("fn/fcl", JSON.parse(JSON.stringify(FE_MANIFEST)));
    executeFunctionality(appDir, "enable_fcl", { defaultLayout: "TwoColumnsMidExpanded" });
    const manifest = JSON.parse(fs.readFileSync(path.join(appDir, "webapp", "manifest.json"), "utf8"));
    expect(manifest["sap.ui5"]["routing"]["config"]["routerClass"]).toBe("sap.f.routing.Router");
    expect(manifest["sap.ui5"]["dependencies"]["libs"]["sap.f"]).toEqual({});

    executeFunctionality(appDir, "update_manifest", { jsonPointer: "sap.app/title", value: "Nuevo título" });
    const manifest2 = JSON.parse(fs.readFileSync(path.join(appDir, "webapp", "manifest.json"), "utf8"));
    expect(manifest2["sap.app"]["title"]).toBe("Nuevo título");
  });
});

// The same destination and servicePath that fetched the metadata should name the service when the
// app is generated, so the manifest does not carry a guessed URL somebody has to notice and fix.
describe("resolving the service URL for a generated app", () => {
  afterEach(() => vi.unstubAllEnvs());

  const configWith = (systems: unknown[], destinations: unknown[] = []) => {
    vi.stubEnv("SAP_SYSTEMS_JSON", JSON.stringify(systems));
    vi.stubEnv("SAP_DESTINATIONS_JSON", JSON.stringify(destinations));
    vi.stubEnv("SAP_DESTINATIONS_DIR", "");
    return loadConfig([]);
  };

  it("composes the URL from a destination and a service path", () => {
    const config = configWith([], [{ Name: "BTP", URL: "https://abap.example", Authentication: "NoAuthentication" }]);
    expect(resolveODataUrl(config, { destination: "BTP", servicePath: "/sap/opu/odata4/sap/x/srvd/sap/y/0001" })).toBe(
      "https://abap.example/sap/opu/odata4/sap/x/srvd/sap/y/0001/"
    );
  });

  it("composes it from a named system too", () => {
    const config = configWith([{ name: "A4H", url: "https://s4.example:44324" }]);
    expect(resolveODataUrl(config, { systemName: "A4H", servicePath: "/srv" })).toBe("https://s4.example:44324/srv/");
  });

  // resolveSystem answers with the first configured system when asked for no name in particular.
  // That is a good default for a query aimed somewhere, and a wrong answer here: an app generated
  // without naming a target would silently carry an unrelated system's host, with no warning.
  it("resolves nothing when the caller named no target at all", () => {
    const config = configWith([{ name: "A4H", url: "https://s4.example:44324" }]);
    expect(resolveODataUrl(config, {})).toBeNull();
  });

  it("returns null when the named target does not exist", () => {
    const config = configWith([{ name: "A4H", url: "https://s4.example" }]);
    expect(resolveODataUrl(config, { destination: "ABSENT", servicePath: "/srv" })).toBeNull();
  });

  it("always ends the URL with a slash, which is what a manifest dataSource expects", () => {
    const config = configWith([], [{ Name: "D", URL: "https://h", Authentication: "NoAuthentication" }]);
    expect(resolveODataUrl(config, { destination: "D" })).toBe("https://h/");
    expect(resolveODataUrl(config, { destination: "D", servicePath: "/a/b" })).toBe("https://h/a/b/");
  });
});
