import { describe, it, expect, beforeAll, afterAll, vi, afterEach } from "vitest";
import { resolveODataUrl } from "../src/btp/destinations.js";
import { loadConfig } from "../src/config.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listFioriApps, summarizeApp, readAppManifest, isCapProject } from "../src/fiori/apps.js";
import { validateManifest } from "../src/ui5/validate.js";
import { runUi5Linter } from "../src/ui5/linter.js";
import { generateFioriApp, pickMainEntitySet, parameterizedEntity } from "../src/fiori/generate.js";
import { parseEdmx } from "../src/odata/edmx.js";
import { feIndexHtml, feManifest, feUi5Yaml } from "../src/fiori/templates.js";
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

  it("passes over a value help, which is listable but is not what an app opens on", () => {
    // a value help needs UI.LineItem for its popup table; only a business entity gets an object page
    const xml = TRAVEL_V4.replace(
      '<Annotations Target="SAP__self.Container/Travel"><Annotation Term="SAP__common.DraftRoot"/></Annotations>',
      ""
    ).replace(
      '<Annotations Target="SAP__self.TravelType"><Annotation Term="SAP__UI.LineItem"/></Annotations>',
      '<Annotations Target="SAP__self.TravelType"><Annotation Term="SAP__UI.LineItem"/><Annotation Term="SAP__UI.HeaderInfo"/></Annotations>'
    );
    expect(pickMainEntitySet(parseEdmx(xml))).toBe("Travel");
  });

  it("prefers the entity that carries the filter bar when several have object pages", () => {
    const xml = TRAVEL_V4.replace(
      '<Annotations Target="SAP__self.Container/Travel"><Annotation Term="SAP__common.DraftRoot"/></Annotations>',
      ""
    )
      .replace(
        '<Annotations Target="SAP__self.BookingType"><Annotation Term="SAP__UI.LineItem"/></Annotations>',
        '<Annotations Target="SAP__self.BookingType"><Annotation Term="SAP__UI.LineItem"/><Annotation Term="SAP__UI.HeaderInfo"/></Annotations>'
      )
      .replace(
        '<Annotations Target="SAP__self.TravelType"><Annotation Term="SAP__UI.LineItem"/></Annotations>',
        '<Annotations Target="SAP__self.TravelType"><Annotation Term="SAP__UI.LineItem"/><Annotation Term="SAP__UI.HeaderInfo"/><Annotation Term="SAP__UI.SelectionFields"/></Annotations>'
      );
    // Booking still comes first in the document, and both navigate to each other
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

describe("a V2 service whose annotations live apart", () => {
  const METADATA_V2 = `<?xml version="1.0"?><edmx:Edmx Version="1.0" xmlns:edmx="http://schemas.microsoft.com/ado/2007/06/edmx">
  <edmx:DataServices xmlns:m="http://schemas.microsoft.com/ado/2007/08/dataservices/metadata" m:DataServiceVersion="2.0">
    <Schema Namespace="svc" xmlns="http://schemas.microsoft.com/ado/2008/09/edm">
      <EntityType Name="AgencyType"><Key><PropertyRef Name="ID"/></Key><Property Name="ID" Type="Edm.String"/></EntityType>
      <EntityType Name="TravelType"><Key><PropertyRef Name="ID"/></Key><Property Name="ID" Type="Edm.String"/></EntityType>
      <EntityContainer Name="Container" m:IsDefaultEntityContainer="true">
        <EntitySet Name="Agency" EntityType="svc.AgencyType"/>
        <EntitySet Name="Travel" EntityType="svc.TravelType"/>
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;
  const ANNOTATIONS = `<?xml version="1.0"?><edmx:Edmx xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx"><edmx:DataServices>
  <Schema xmlns="http://docs.oasis-open.org/odata/ns/edm" Namespace="van.v1">
    <Annotations Target="svc.TravelType"><Annotation Term="UI.LineItem"/></Annotations>
  </Schema></edmx:DataServices></edmx:Edmx>`;

  it("declares the document, saves a copy, and lets it decide the entity set", async () => {
    const ws = path.join(tmp, "gen-ann", "ws");
    fs.mkdirSync(ws, { recursive: true });
    const result = await generateFioriApp({
      targetPath: ws,
      appName: "travelv2",
      title: "Travel",
      metadataXml: METADATA_V2,
      annotationDocuments: [{ technicalName: "ZTRAVEL_VAN", url: "https://abap.example.com/sap/opu/odata/IWFND/CATALOGSERVICE;v=2/Annotations('ZTRAVEL_VAN')/$value", xml: ANNOTATIONS }],
      serviceUrl: "/sap/opu/odata/sap/ZTRAVEL/",
      floorplan: "list-report",
      isCap: false
    });
    const manifest = JSON.parse(fs.readFileSync(path.join(result.appPath, "webapp", "manifest.json"), "utf8"));
    const sources = manifest["sap.app"]["dataSources"];
    expect(sources["ZTRAVEL_VAN"]["type"]).toBe("ODataAnnotation");
    // a served app cannot reach an absolute URL to the backend host: the annotations never arrive
    // and the list report renders without columns
    expect(sources["ZTRAVEL_VAN"]["uri"]).toBe("/sap/opu/odata/IWFND/CATALOGSERVICE;v=2/Annotations('ZTRAVEL_VAN')/$value");
    expect(sources["mainService"]["settings"]["annotations"]).toEqual(["ZTRAVEL_VAN"]);
    // the app must work offline too, so the document travels with it
    expect(fs.existsSync(path.join(result.appPath, "webapp", "localService", "ZTRAVEL_VAN.xml"))).toBe(true);
    // Agency comes first in the document; only the annotation says Travel is the listable one
    // (a v2 app names its pages in sap.ui.generic.app, not in routing targets)
    expect(Object.keys(manifest["sap.ui.generic.app"]["pages"])).toEqual(["ListReport|Travel"]);
    const check = await validateManifest(result.appPath);
    expect(check.issues).toEqual([]);
  });

  it("generates exactly as before when no document is supplied", async () => {
    const ws = path.join(tmp, "gen-noann", "ws");
    fs.mkdirSync(ws, { recursive: true });
    const result = await generateFioriApp({
      targetPath: ws,
      appName: "travelplain",
      title: "Travel",
      metadataXml: METADATA_V2,
      serviceUrl: "/sap/opu/odata/sap/ZTRAVEL/",
      floorplan: "list-report",
      isCap: false
    });
    const manifest = JSON.parse(fs.readFileSync(path.join(result.appPath, "webapp", "manifest.json"), "utf8"));
    expect(Object.keys(manifest["sap.app"]["dataSources"])).toEqual(["mainService"]);
    expect(manifest["sap.app"]["dataSources"]["mainService"]["settings"]["annotations"]).toBeUndefined();
    expect(Object.keys(manifest["sap.ui.generic.app"]["pages"])).toEqual(["ListReport|Agency"]);
  });
});

const PARAMETERIZED = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="srv" Alias="SAP__self" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="OtherType"><Key><PropertyRef Name="Id"/></Key><Property Name="Id" Type="Edm.String"/></EntityType>
      <EntityType Name="StatsParameters">
        <Key><PropertyRef Name="p_from"/><PropertyRef Name="p_to"/></Key>
        <Property Name="p_from" Type="Edm.Date"/>
        <Property Name="p_to" Type="Edm.Date"/>
        <NavigationProperty Name="Set" Type="Collection(srv.StatsType)"/>
      </EntityType>
      <EntityType Name="StatsType"><Key><PropertyRef Name="Id"/></Key><Property Name="Id" Type="Edm.String"/></EntityType>
      <EntityContainer Name="Container">
        <EntitySet Name="Other" EntityType="srv.OtherType"/>
        <EntitySet Name="Stats" EntityType="srv.StatsParameters"/>
      </EntityContainer>
      <Annotations Target="SAP__self.StatsType">
        <Annotation Term="SAP__UI.LineItem"/><Annotation Term="SAP__UI.HeaderInfo"/>
      </Annotations>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

describe("a CDS with parameters", () => {
  it("reads the parameters and the navigation that leads to the rows", () => {
    const p = parameterizedEntity(parseEdmx(PARAMETERIZED), "Stats");
    expect(p).toEqual({ entitySet: "Stats", navigation: "Set", parameters: ["p_from", "p_to"], resultType: "StatsType" });
    // an ordinary set is not mistaken for one
    expect(parameterizedEntity(parseEdmx(PARAMETERIZED), "Other")).toBeNull();
  });

  it("finds the annotated set even though the terms sit on the far side of the navigation", () => {
    expect(pickMainEntitySet(parseEdmx(PARAMETERIZED))).toBe("Stats");
  });

  it("addresses the list through the parameters instead of the parameter records", async () => {
    const ws = path.join(tmp, "gen-param", "ws");
    fs.mkdirSync(ws, { recursive: true });
    const result = await generateFioriApp({
      targetPath: ws,
      appName: "stats",
      title: "Stats",
      metadataXml: PARAMETERIZED,
      serviceUrl: "/odata/v4/stats/",
      floorplan: "list-report",
      isCap: false
    });
    const manifest = JSON.parse(fs.readFileSync(path.join(result.appPath, "webapp", "manifest.json"), "utf8"));
    const settings = manifest["sap.ui5"]["routing"]["targets"]["StatsList"]["options"]["settings"];
    // a list of parameter records is not an app; the rows live behind the navigation
    expect(settings["contextPath"]).toBe("/Stats/Set");
    expect(settings["entitySet"]).toBeUndefined();
    // the caller must know parameters will be demanded before any data appears
    expect(result.warnings.join(" ")).toMatch(/p_from, p_to/);
    const check = await validateManifest(result.appPath);
    expect(check.issues).toEqual([]);
  });

  it("generates no object page, because sap.fe has none for a parameterised entity", async () => {
    const ws = path.join(tmp, "gen-param-noop", "ws");
    fs.mkdirSync(ws, { recursive: true });
    const result = await generateFioriApp({
      targetPath: ws,
      appName: "statsnoop",
      title: "Stats",
      metadataXml: PARAMETERIZED,
      serviceUrl: "/odata/v4/stats/",
      floorplan: "list-report",
      isCap: false
    });
    const manifest = JSON.parse(fs.readFileSync(path.join(result.appPath, "webapp", "manifest.json"), "utf8"));
    const routing = manifest["sap.ui5"]["routing"];
    // sap.fe resolves such a page against the parameter entity and asks for paths that do not exist
    // (…/Set('1')/p_from, …/Set('1')/Set/TravelId), so the detail page could only ever open empty
    expect(Object.keys(routing.targets)).toEqual(["StatsList"]);
    expect(routing.routes.map((r: { pattern: string }) => r.pattern)).toEqual([":?query:"]);
    // a row must not offer a navigation that leads nowhere
    expect(routing.targets.StatsList.options.settings.navigation).toBeUndefined();
    expect(result.warnings.join(" ")).toMatch(/No object page was generated/);
    const check = await validateManifest(result.appPath);
    expect(check.issues).toEqual([]);
  });

  it("leaves an ordinary app addressed by entity set", async () => {
    const ws = path.join(tmp, "gen-param-plain", "ws");
    fs.mkdirSync(ws, { recursive: true });
    const result = await generateFioriApp({
      targetPath: ws,
      appName: "plain",
      title: "Plain",
      metadataXml: PARAMETERIZED,
      entitySet: "Other",
      serviceUrl: "/odata/v4/stats/",
      floorplan: "list-report",
      isCap: false
    });
    const manifest = JSON.parse(fs.readFileSync(path.join(result.appPath, "webapp", "manifest.json"), "utf8"));
    const settings = manifest["sap.ui5"]["routing"]["targets"]["OtherList"]["options"]["settings"];
    expect(settings["entitySet"]).toBe("Other");
    expect(settings["contextPath"]).toBeUndefined();
    expect(manifest["sap.ui5"]["routing"]["routes"][1]["pattern"]).toBe("Other({otherKey}):?query:");
  });
});

describe("the generated package.json", () => {
  const make = (isCap: boolean, appName: string) =>
    generateFioriApp({
      targetPath: fs.mkdtempSync(path.join(os.tmpdir(), "mcp-pkg-")),
      appName,
      title: "T",
      entitySet: "Books",
      serviceUrl: "/odata/v4/browse/",
      floorplan: "list-report",
      isCap
    });

  it("is JSON a parser accepts, inside a CAP project and outside it", async () => {
    for (const isCap of [true, false]) {
      const result = await make(isCap, isCap ? "capapp" : "soloapp");
      const raw = fs.readFileSync(path.join(result.appPath, "package.json"), "utf8");
      // the CAP branch used to emit a bare {} where a member belonged
      expect(() => JSON.parse(raw)).not.toThrow();
      const pkg = JSON.parse(raw);
      expect(pkg.name).toBeTruthy();
      // cds serves an app inside a CAP project: a second toolchain there is noise
      if (isCap) expect(pkg.devDependencies).toBeUndefined();
      else expect(pkg.devDependencies["@ui5/cli"]).toBeTruthy();
    }
  });
});

describe("what makes a generated app actually run in a browser", () => {
  const opts = (over: Record<string, unknown> = {}) =>
    ({
      namespace: "ns",
      appId: "ns.app",
      appName: "app",
      title: "T",
      entitySet: "Travels",
      mainEntity: "Travels",
      odataVersion: "4.0" as const,
      serviceUri: "/srv/",
      addFcl: false,
      floorplan: "list-report" as const,
      ...over
    }) as Parameters<typeof feManifest>[0];

  it("bootstraps the component instead of leaving an inert page", () => {
    const html = feIndexHtml(opts());
    // a quoted list inside a double-quoted attribute ends the attribute early
    expect(html).toContain('data-sap-ui-libraries="sap.m,sap.fe.templates"');
    // without ComponentSupport nothing ever instantiates the component
    expect(html).toContain('data-sap-ui-oninit="module:sap/ui/core/ComponentSupport"');
    // ComponentSupport reads data-name, not the sap-ui-prefixed spelling
    expect(html).toContain('data-name="ns.app"');
    // the container is 100% of a body that otherwise has no height
    expect(html).toMatch(/html, body, #content, #root \{ height: 100%/);
  });

  it("pairs the root view with the router class sap.fe insists on", () => {
    const plain = JSON.parse(feManifest(opts()))["sap.ui5"];
    expect(plain.rootView.viewName).toBe("sap.fe.core.rootView.NavContainer");
    expect(plain.routing.config.routerClass).toBe("sap.m.routing.Router");
    const fcl = JSON.parse(feManifest(opts({ addFcl: true })))["sap.ui5"];
    expect(fcl.rootView.viewName).toBe("sap.fe.core.rootView.Fcl");
    expect(fcl.routing.config.routerClass).toBe("sap.f.routing.Router");
    // a v2 app names no root view at all: its AppComponent builds one from sap.ui.generic.app
    const v2 = JSON.parse(feManifest(opts({ odataVersion: "2.0" })));
    expect(v2["sap.ui5"].rootView).toBeUndefined();
    expect(Object.keys(v2["sap.ui.generic.app"].pages)).toEqual(["ListReport|Travels"]);
  });

  it("gives a v2 app the page hierarchy its templates read", () => {
    const v2 = JSON.parse(feManifest(opts({ odataVersion: "2.0" })));
    const generic = v2["sap.ui.generic.app"];
    // without this AppComponent starts, finds no page and logs "page stack is empty"
    const list = generic.pages["ListReport|Travels"];
    expect(list.entitySet).toBe("Travels");
    expect(list.component.name).toBe("sap.suite.ui.generic.template.ListReport");
    expect(list.pages["ObjectPage|Travels"].component.name).toBe("sap.suite.ui.generic.template.ObjectPage");
    // the v4 templates read routing instead and want none of it
    expect(JSON.parse(feManifest(opts()))["sap.ui.generic.app"]).toBeUndefined();
  });

  it("asks the tooling for the libraries a v2 app cannot start without", () => {
    const yaml = feUi5Yaml(opts({ odataVersion: "2.0" }), false);
    for (const lib of ["sap.suite.ui.generic.template", "sap.ui.comp", "sap.ushell"]) {
      expect(yaml).toContain(`    - name: ${lib}`);
    }
  });

  it("lets a row reach the object page", () => {
    const m = JSON.parse(feManifest(opts()))["sap.ui5"];
    // without this, clicking a row selects a cell and nothing happens
    expect(m.routing.targets.TravelsList.options.settings.navigation).toEqual({
      Travels: { detail: { route: "TravelsObjectPage" } }
    });
  });

  it("declares the libraries the tooling has to download, at the version the manifest asks for", () => {
    const yaml = feUi5Yaml(opts(), false);
    expect(yaml).toContain("framework:");
    expect(yaml).toContain("    - name: sap.fe.templates");
    expect(yaml).toContain("    - name: themelib_sap_horizon");
    const minVersion = JSON.parse(feManifest(opts()))["sap.ui5"].dependencies.minUI5Version;
    expect(yaml).toContain(`version: "${minVersion}"`);
    // mountPath belongs to the middleware entry; inside configuration the proxy swallows every path
    expect(yaml).toContain("      mountPath: /sap");
    expect(yaml).not.toContain("        mountPath: /sap");
  });
});

describe("telling the caller what a floorplan will not do", () => {
  const METADATA_ALP = `<?xml version="1.0"?><edmx:Edmx Version="1.0" xmlns:edmx="http://schemas.microsoft.com/ado/2007/06/edmx">
  <edmx:DataServices xmlns:m="http://schemas.microsoft.com/ado/2007/08/dataservices/metadata" m:DataServiceVersion="2.0">
    <Schema Namespace="svc" xmlns="http://schemas.microsoft.com/ado/2008/09/edm">
      <EntityType Name="TravelType"><Key><PropertyRef Name="ID"/></Key>
        <Property Name="ID" Type="Edm.String"/><Property Name="AgencyName" Type="Edm.String"/><Property Name="Memo" Type="Edm.String"/>
      </EntityType>
      <EntityContainer Name="Container" m:IsDefaultEntityContainer="true">
        <EntitySet Name="Travel" EntityType="svc.TravelType"/>
      </EntityContainer>
      <Annotations Target="svc.TravelType" xmlns="http://docs.oasis-open.org/odata/ns/edm">
        <Annotation Term="UI.LineItem"/>
      </Annotations>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

  const generate = (floorplan: "analytical-list-page" | "list-report" | "overview-page", name: string) =>
    generateFioriApp({
      targetPath: fs.mkdtempSync(path.join(os.tmpdir(), "mcp-fp-")),
      appName: name,
      title: "T",
      entitySet: "Travel",
      metadataXml: METADATA_ALP,
      serviceUrl: "/sap/opu/odata/sap/Z/",
      odataVersion: "2.0",
      floorplan,
      isCap: false
    });

  it("says when the service lacks the annotations the floorplan needs", async () => {
    const alp = await generate("analytical-list-page", "alpapp");
    // an ALP without a chart opens on an error dialog, and the metadata says so beforehand
    expect(alp.warnings.join(" ")).toMatch(/UI\.Chart/);
    expect(alp.warnings.join(" ")).toMatch(/UI\.PresentationVariant/);
    // the list report has what it needs here, and must not be nagged about it
    const lr = await generate("list-report", "lrapp");
    expect(lr.warnings.join(" ")).not.toMatch(/floorplan needs/);
  });

  it("does not pass off the overview page as finished", async () => {
    const ovp = await generate("overview-page", "ovpapp");
    expect(ovp.warnings.join(" ")).toMatch(/scaffold/);
  });

  it("takes the overview card's fields from the entity instead of inventing them", async () => {
    const ovp = await generate("overview-page", "ovpfields");
    const manifest = JSON.parse(fs.readFileSync(path.join(ovp.appPath, "webapp", "manifest.json"), "utf8"));
    const settings = manifest["sap.ovp"].cards.card00.settings;
    // the template used to name /Name and /Description, which most services do not have
    expect(settings.itemTitle).toBe("/AgencyName");
    expect(settings.itemSubTitle).toBe("/Memo");
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
