import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import zlib from "node:zlib";
import { AddressInfo } from "node:net";
import { loadConfig, type AppConfig } from "../src/config.js";
import {
  appUi5Version,
  frontendAppUrl,
  manifestServiceUris,
  repositoryPayload,
  rewriteBootstrap,
  sanitizeBspName,
  validateBspName
} from "../src/deploy/bsp.js";
import { deployFioriApp, inferTarget } from "../src/deploy/index.js";
import { candidatePackageName, looksLikePackageRefusal, packageCreatePayload } from "../src/deploy/package.js";
import { buildApp, projectRootOf, resolveUi5Cli } from "../src/deploy/build.js";
import { zipFolder } from "../src/deploy/zip.js";
import { feComponentJs, feIndexHtml, feManifest, feUi5Yaml } from "../src/fiori/templates.js";
import { validateManifest } from "../src/ui5/validate.js";

// --- a minimal zip reader ---------------------------------------------------------------
// Enough to prove the archive that ships really contains the rewritten index.html.

interface CentralEntry { name: string; method: number; csize: number; offset: number }

function centralEntries(buf: Buffer): CentralEntry[] {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  expect(eocd, "zip end-of-central-directory record missing").toBeGreaterThan(0);
  const count = buf.readUInt16LE(eocd + 10);
  let pos = buf.readUInt32LE(eocd + 16);
  const entries: CentralEntry[] = [];
  for (let i = 0; i < count; i++) {
    expect(buf.readUInt32LE(pos)).toBe(0x02014b50);
    const method = buf.readUInt16LE(pos + 10);
    const csize = buf.readUInt32LE(pos + 20);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const offset = buf.readUInt32LE(pos + 42);
    entries.push({ name: buf.subarray(pos + 46, pos + 46 + nameLen).toString("utf8"), method, csize, offset });
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function readZipEntry(buf: Buffer, name: string): string {
  const entry = centralEntries(buf).find((e) => e.name === name);
  expect(entry, `${name} is not in the archive`).toBeTruthy();
  const nameLen = buf.readUInt16LE(entry!.offset + 26);
  const extraLen = buf.readUInt16LE(entry!.offset + 28);
  const start = entry!.offset + 30 + nameLen + extraLen;
  const data = buf.subarray(start, start + entry!.csize);
  return (entry!.method === 8 ? zlib.inflateRawSync(data) : data).toString("utf8");
}

// --- fixtures --------------------------------------------------------------------------------

const feOpts = {
  namespace: "ns",
  appId: "ns.deployapp",
  appName: "deployapp",
  title: "Deploy App",
  entitySet: "Travels",
  mainEntity: "Travels",
  odataVersion: "4.0" as const,
  addFcl: false,
  floorplan: "list-report" as const
};

function writeApp(root: string, serviceUri: string): string {
  const appPath = path.join(root, "deployed-app");
  const webapp = path.join(appPath, "webapp");
  fs.mkdirSync(path.join(webapp, "i18n"), { recursive: true });
  const opts = { ...feOpts, serviceUri };
  fs.writeFileSync(path.join(webapp, "manifest.json"), feManifest(opts));
  fs.writeFileSync(path.join(webapp, "index.html"), feIndexHtml(opts));
  fs.writeFileSync(path.join(webapp, "Component.js"), feComponentJs(opts));
  fs.writeFileSync(path.join(webapp, "i18n", "i18n.properties"), "appTitle=Deploy App\nappDescription=Deploys a travel\n");
  fs.writeFileSync(path.join(appPath, "ui5.yaml"), feUi5Yaml(opts, false));
  fs.writeFileSync(path.join(appPath, "package.json"), JSON.stringify({ name: "deployed-app", version: "1.0.0" }, null, 2));
  return appPath;
}

function emptyDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fiori-mcp-deploy-"));
  fs.mkdirSync(path.join(dir, "destinations"), { recursive: true });
  return dir;
}

function testConfig(systems: AppConfig["sapSystems"], dataDir: string): AppConfig {
  return { ...loadConfig([]), sapSystems: systems, dataDir, allowedDomains: [], logLevel: "off", requestTimeoutMs: 8000 };
}

// --- the ABAP side, simulated --------------------------------------------------------------

interface MockRequest { method: string; url: string; body: string; headers: http.IncomingHttpHeaders }

describe("ABAP UI5 repository contract", () => {
  it("derives a BSP name ABAP accepts", () => {
    expect(sanitizeBspName("deployed-app").name).toBe("ZDEPLOYED_APP");
    expect(sanitizeBspName("travel").name).toBe("ZTRAVEL");
    expect(sanitizeBspName("zbookings").name).toBe("ZBOOKINGS"); // no second Z
    expect(sanitizeBspName("___").name).toBe("ZAPP");
    const long = sanitizeBspName("an-application-name-that-is-way-too-long");
    expect(long.name).toHaveLength(15);
    expect(long.warnings.join(" ")).toMatch(/truncated/i);
    expect(sanitizeBspName("deployed-app").adjustedFrom).toBe("deployed-app");
    expect(() => validateBspName("has-dash")).toThrow(/Invalid BSP name/);
    expect(() => validateBspName("/mycompany/myapp")).not.toThrow();
    expect(() => validateBspName("/averylongnamespac/ok")).toThrow(/Invalid BSP name/);
  });

  it("encodes the archive into the Atom entry the service reads", () => {
    const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x26, 0x26]);
    const payload = repositoryPayload({
      serviceUrl: "https://host.example/sap/opu/odata/UI5/ABAP_REPOSITORY_SRV",
      name: "ZTEST",
      description: 'A "quoted" & <tagged> description',
      abapPackage: "$TMP",
      zip
    });
    expect(payload).toContain("<entry ");
    expect(payload).toContain("xml:base=\"https://host.example/sap/opu/odata/UI5/ABAP_REPOSITORY_SRV\"");
    expect(payload).toContain("<d:Name>ZTEST</d:Name>");
    expect(payload).toContain("<d:Package>$TMP</d:Package>");
    expect(payload).toContain("&quot;quoted&quot; &amp; &lt;tagged&gt;");
    expect(payload).toContain(`<d:ZipArchive>${zip.toString("base64")}</d:ZipArchive>`);
    expect(payload.trim().endsWith("</entry>")).toBe(true);
  });

  it("serves the application on the host a browser can reach", () => {
    expect(frontendAppUrl("https://s4h.example.internal:8443", "ZMyApp", "100")).toBe(
      "https://s4h.example.internal:8443/sap/bc/ui5_ui5/sap/zmyapp?sap-client=100"
    );
    // ABAP Environment: .abap. is the technical host, .abap-web. is the web one
    expect(frontendAppUrl("https://abc-123.abap.us10.hana.ondemand.com", "ZAPP")).toBe(
      "https://abc-123.abap-web.us10.hana.ondemand.com/sap/bc/ui5_ui5/sap/zapp"
    );
    expect(frontendAppUrl("https://host.example", "/mycompany/myapp")).toBe(
      "https://host.example/sap/bc/ui5_ui5/mycompany/myapp"
    );
  });

  it("points index.html at a framework the browser can fetch", () => {
    const html = feIndexHtml({ ...feOpts, serviceUri: "/srv/" });
    expect(html).toContain('src="resources/sap-ui-core.js"');

    const cdn = rewriteBootstrap(html, { mode: "cdn", version: "1.130.0" });
    expect(cdn.changed).toBe(true);
    expect(cdn.from).toBe("resources/sap-ui-core.js");
    expect(cdn.to).toBe("https://ui5.sap.com/1.130.0/resources/sap-ui-core.js");
    expect(cdn.html).toContain('src="https://ui5.sap.com/1.130.0/resources/sap-ui-core.js"');
    expect(cdn.html).not.toContain('src="resources/sap-ui-core.js"');

    // already absolute: leave it alone
    const absolute = rewriteBootstrap('<script src="https://ui5.sap.com/x/resources/sap-ui-core.js"></script>', { mode: "cdn" });
    expect(absolute.changed).toBe(false);

    const local = rewriteBootstrap(html, { mode: "local", localRoot: "/sap/bc/ui5_ui5/ui2/ushell/resources" });
    expect(local.to).toBe("/sap/bc/ui5_ui5/ui2/ushell/resources/sap-ui-core.js");

    const keep = rewriteBootstrap(html, { mode: "keep" });
    expect(keep.changed).toBe(false);
    expect(keep.html).toBe(html);

    expect(rewriteBootstrap("<html>no framework here</html>", { mode: "cdn" }).changed).toBe(false);
  });

  it("reads the UI5 version the application asks for", () => {
    const manifest = JSON.parse(feManifest({ ...feOpts, serviceUri: "/srv/" }));
    expect(appUi5Version(manifest, process.cwd())).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("collects every service URI the manifest declares", () => {
    const manifest = JSON.parse(feManifest({ ...feOpts, serviceUri: "https://host.example/odata/v4/" }));
    expect(manifestServiceUris(manifest)).toContain("https://host.example/odata/v4/");
  });
});

describe("build and archive", () => {
  let root: string;
  beforeAll(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "fiori-mcp-build-")); });
  afterAll(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it("locates the app folder and refuses anything that is not one", () => {
    const app = writeApp(root, "/srv/");
    expect(projectRootOf(app)).toBe(app);
    expect(projectRootOf(path.join(app, "webapp"))).toBe(app);
    expect(() => projectRootOf(root)).toThrow(/No webapp\/manifest.json/);
    expect(resolveUi5Cli(app)).toBeNull(); // nothing installed in the fixture
  });

  it("ships the source folder when the tooling is not installed", async () => {
    const app = writeApp(root, "/srv/");
    const outcome = await buildApp(app, { install: false });
    expect(outcome.mode).toBe("source");
    expect(outcome.built).toBe(false);
    expect(outcome.dir).toBe(path.join(app, "webapp"));
    expect(outcome.warnings.join(" ")).toMatch(/@ui5\/cli is not installed/);

    const skipped = await buildApp(app, { skipBuild: true });
    expect(skipped.mode).toBe("source");
    expect(skipped.warnings.join(" ")).toMatch(/skipBuild/);
  });

  it("zips the folder at archive root, with overrides applied", async () => {
    const app = writeApp(root, "/srv/");
    const { buffer, files } = await zipFolder(path.join(app, "webapp"), [
      { path: "index.html", content: "<html>rewritten</html>" }
    ]);
    expect(buffer.subarray(0, 4).toString("latin1")).toBe("PK\u0003\u0004");
    expect(files).toContain("manifest.json");
    expect(files).toContain("i18n/i18n.properties");
    expect(readZipEntry(buffer, "index.html")).toBe("<html>rewritten</html>");
    expect(JSON.parse(readZipEntry(buffer, "manifest.json"))["sap.app"].id).toBe(feOpts.appId);
  });
});

describe("target selection", () => {
  it("reads the target out of the manifest's own service URL", () => {
    const dataDir = emptyDataDir();
    const config = testConfig(
      [{ name: "A4H", url: "https://s4h24.example:44324", user: "u", password: "p", client: "100" }],
      dataDir
    );
    expect(inferTarget(config, ["https://s4h24.example:44324/odata/v4/"])?.systemName).toBe("A4H");
    expect(inferTarget(config, ["/relative/uri/"])).toBeNull();
    expect(inferTarget(config, ["https://somewhere.else/odata"])).toBeNull();
    // the browser-facing .abap-web. host still maps back to the configured system
    expect(inferTarget(config, ["https://host.example/sap/opu/odata/"])).toBeNull();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("maps .abap-web. back onto a configured ABAP Environment destination", () => {
    const dataDir = emptyDataDir();
    fs.writeFileSync(
      path.join(dataDir, "destinations", "BTP.json"),
      JSON.stringify({ Name: "BTP", URL: "https://abc-123.abap.us10.hana.ondemand.com", Authentication: "NoAuthentication" })
    );
    const config = testConfig([], dataDir);
    expect(inferTarget(config, ["https://abc-123.abap-web.us10.hana.ondemand.com/odata/v4/"])?.destination).toBe("BTP");
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
});

describe("deploy_fiori_app against an ABAP system", () => {
  let server: http.Server;
  let origin: string;
  let dataDir: string;
  let config: AppConfig;
  let appPath: string;
  let workDir: string;
  const requests: MockRequest[] = [];
  let repositoryExists = false;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const url = req.url ?? "";
        const body = Buffer.concat(chunks).toString("utf8");
        requests.push({ method: req.method ?? "", url, body, headers: req.headers });

        if (req.method === "GET" && url.endsWith("/$metadata")) {
          res.writeHead(200, {
            "content-type": "application/xml;charset=utf-8",
            "x-csrf-token": "TOKEN-123",
            "set-cookie": "SAP_SESSIONID_ABC=xyz; Path=/; HttpOnly"
          });
          res.end("<edmx:Edmx/>");
          return;
        }
        if (req.method === "GET" && url.includes("/Repositories('")) {
          if (repositoryExists) {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ d: { Name: "ZDEPLOYED_APP", Package: "$TMP" } }));
          } else {
            res.writeHead(404, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: { code: "not_found", message: { value: "not deployed" } } }));
          }
          return;
        }
        // IWFND refuses any write whose token is missing, or whose session is not the one it came from
        const csrfBroken =
          req.headers["x-csrf-token"] !== "TOKEN-123" || !/SAP_SESSIONID_ABC=xyz/.test(req.headers.cookie ?? "");
        if ((req.method === "POST" || req.method === "PUT") && url.includes("/Repositories") && csrfBroken) {
          res.writeHead(403, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { code: "CSRF", message: { value: "CSRF token validation failed" } } }));
          return;
        }
        if (req.method === "POST" && url.includes("/Repositories?")) {
          repositoryExists = true;
          res.writeHead(201, {
            "content-type": "application/atom+xml;charset=utf-8",
            "sap-message": JSON.stringify({ severity: "info", message: "BSP application created" })
          });
          res.end("<entry/>");
          return;
        }
        if (req.method === "PUT" && url.includes("/Repositories('")) {
          res.writeHead(200, {
            "content-type": "application/atom+xml;charset=utf-8",
            "sap-message": JSON.stringify({ severity: "info", message: "BSP application updated" })
          });
          res.end("<entry/>");
          return;
        }
        if (url.startsWith("/sap/bc/ui5_ui5/sap/")) {
          res.writeHead(200, { "content-type": "text/html;charset=utf-8" });
          res.end("<html><body>app</body></html>");
          return;
        }
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "fiori-mcp-deploy-e2e-"));
    dataDir = emptyDataDir();
    appPath = writeApp(workDir, `${origin}/odata/v4/`);
    config = testConfig([{ name: "MOCK", url: origin, user: "u", password: "p", client: "100" }], dataDir);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(workDir, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("starts from an application the tool would accept", () => {
    expect(validateManifest(appPath).errors).toBe(0);
    expect(fs.existsSync(path.join(appPath, "webapp", "index.html"))).toBe(true);
  });

  it("publishes the application and proves it answers", async () => {
    const result = await deployFioriApp({ config, appPath, install: false, bootstrapCheck: false });

    expect(result.ok).toBe(true);
    expect(result.stage).toBe("verify");
    expect(result.action).toBe("created");
    expect(result.target.kind).toBe("system");
    expect(result.target.name).toBe("MOCK");
    // inferred from the manifest, not passed in
    expect(result.target.inferred).toBe(true);
    expect(result.bsp.name).toBe("ZDEPLOYED_APP");
    expect(result.bsp.package).toBe("$TMP");
    expect(result.build.mode).toBe("source"); // no @ui5/cli in the fixture
    expect(result.archive.bytes).toBeGreaterThan(100);
    expect(result.archive.files).toBeGreaterThan(3);
    expect(result.verification).toMatchObject({ attempted: true, ok: true, status: 200 });
    expect(result.appUrl).toBe(`${origin}/sap/bc/ui5_ui5/sap/zdeployed_app?sap-client=100`);
    expect(result.sapMessage).toContain("BSP application created");
    expect(result.nextSteps.join(" ")).toContain(result.appUrl);

    const upload = requests.find((r) => r.method === "POST");
    expect(upload, "the create request never arrived").toBeTruthy();
    // quotes arrive percent-encoded, which is what the service decodes back to the OData literal
    const query = decodeURIComponent(upload!.url.split("?")[1] ?? "");
    expect(query).toContain("CodePage='UTF8'");
    expect(query).toContain("CondenseMessagesInHttpResponseHeader=X");
    expect(query).toContain("format=json");
    // a SystemQueryOption on a create is answered with 400 by IWFND
    expect(query).not.toContain("$format");
    // the token comes from a $metadata probe and travels with the session it was minted in
    expect(upload!.headers["x-csrf-token"]).toBe("TOKEN-123");
    expect(upload!.headers.cookie).toContain("SAP_SESSIONID_ABC=xyz");
    expect(requests.some((r) => r.url.endsWith("/$metadata") && r.headers["x-csrf-token"] === "fetch")).toBe(true);
    expect(upload!.body).toContain("<d:Name>ZDEPLOYED_APP</d:Name>");
    expect(upload!.body).toContain("<d:Package>$TMP</d:Package>");
    expect(upload!.body).toContain("<d:Description>Deploy App</d:Description>");

    // the archive inside the payload starts with the zip magic and carries the rewritten bootstrap
    const base64 = /<d:ZipArchive>([^<]+)<\/d:ZipArchive>/.exec(upload!.body)?.[1] ?? "";
    const archive = Buffer.from(base64, "base64");
    expect(archive.subarray(0, 4).toString("latin1")).toBe("PK\u0003\u0004");
    const shippedIndex = readZipEntry(archive, "index.html");
    expect(shippedIndex).toContain(`src="${result.bootstrap.to}"`);
    expect(shippedIndex).not.toContain('src="resources/sap-ui-core.js"');
    expect(result.bootstrap).toMatchObject({ mode: "cdn", changed: true });
  });

  it("updates the same BSP on a second deploy instead of creating it again", async () => {
    const before = requests.length;
    const result = await deployFioriApp({ config, appPath, install: false, bootstrapCheck: false, skipBuild: true });
    expect(result.action).toBe("updated");
    expect(result.ok).toBe(true);
    const methods = requests.slice(before).map((r) => r.method);
    expect(methods).toContain("PUT");
    expect(methods).not.toContain("POST");
  });

  it("reports the system's own refusal instead of claiming success", async () => {
    const failing = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(403, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: { code: "/IWFND/CM_CONSUMER/101", message: { lang: "en", value: "No authorization to access Service" } }
          })
        );
      });
    });
    await new Promise<void>((resolve) => failing.listen(0, "127.0.0.1", resolve));
    const port = (failing.address() as AddressInfo).port;
    const other = testConfig([{ name: "DENIED", url: `http://127.0.0.1:${port}`, user: "u", password: "p", client: "100" }], emptyDataDir());

    await expect(
      deployFioriApp({ config: other, appPath, install: false, bootstrapCheck: false, systemName: "DENIED" })
    ).rejects.toThrow(/No authorization to access Service/);

    await new Promise<void>((resolve) => failing.close(() => resolve()));
    fs.rmSync(other.dataDir, { recursive: true, force: true });
  });

  it("proves the application answers even when the system protects its UI5 repository", async () => {
    const gated = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const url = req.url ?? "";
        if (req.method === "GET" && url.includes("/Repositories('")) {
          res.writeHead(404, { "content-type": "application/json" });
          res.end("{}");
          return;
        }
        if (req.method === "POST" && url.includes("/Repositories?")) {
          res.writeHead(201, {
            "content-type": "application/atom+xml;charset=utf-8",
            "sap-message": JSON.stringify({ severity: "info", message: "created" })
          });
          res.end("<entry/>");
          return;
        }
        if (url.startsWith("/sap/bc/ui5_ui5/sap/")) {
          if (req.headers.authorization) {
            res.writeHead(200, { "content-type": "text/html;charset=utf-8" });
            res.end("<html><body>app</body></html>");
          } else {
            res.writeHead(401, { "www-authenticate": 'Basic realm="SAP"' });
            res.end("sign in");
          }
          return;
        }
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
      });
    });
    await new Promise<void>((resolve) => gated.listen(0, "127.0.0.1", resolve));
    const port = (gated.address() as AddressInfo).port;
    const gatedOrigin = `http://127.0.0.1:${port}`;
    const dataDir = emptyDataDir();
    const cfg = testConfig([{ name: "GATED", url: gatedOrigin, user: "u", password: "p", client: "100" }], dataDir);
    const app = writeApp(path.join(workDir, "gated"), `${gatedOrigin}/odata/v4/`);

    const result = await deployFioriApp({ config: cfg, appPath: app, install: false, bootstrapCheck: false });

    expect(result.action).toBe("created");
    expect(result.ok).toBe(true);
    // the anonymous attempt got 401, the one with credentials 200
    expect(result.verification).toMatchObject({ attempted: true, ok: true, status: 200 });
    expect(result.verification.note).toMatch(/protects this URL/);

    await new Promise<void>((resolve) => gated.close(() => resolve()));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("refuses a target that cannot be determined", async () => {
    const isolated = testConfig([{ name: "ONE", url: "https://one.example" }, { name: "TWO", url: "https://two.example" }], emptyDataDir());
    // a separate folder: this one deliberately points at a relative service URL
    const app = writeApp(path.join(workDir, "no-target"), "/relative/service/");
    await expect(
      deployFioriApp({ config: isolated, appPath: app, install: false, bootstrapCheck: false })
    ).rejects.toThrow(/Pass systemName/);
    fs.rmSync(isolated.dataDir, { recursive: true, force: true });
  });
});

// --- package recovery --------------------------------------------------------------------------

/**
 * A system that speaks both protocols the flow needs: the UI5 repository (OData) and the package
 * infrastructure behind it (ADT). Enough of each to reproduce what ABAP Environment does — refuse
 * `$TMP`, then offer the customer software component a package can hang from.
 */
interface MockSystemOptions {
  /** Software components ADT lists (default: the local development one). `null` = no ADT at all. */
  components?: string[] | null;
  /** Packages whose upload is refused, like `$TMP` is on ABAP Environment. */
  refusePackages?: string[];
  /** Packages that already exist, name → software component. */
  packages?: Record<string, string>;
}

interface MockSystem {
  origin: string;
  requests: MockRequest[];
  close: () => Promise<void>;
}

const NAMED_ITEMS_TYPE = "application/vnd.sap.adt.nameditems.v1+xml";
const PACKAGE_TYPE = "application/vnd.sap.adt.packages.v2+xml";

async function startMockSystem(opts: MockSystemOptions = {}): Promise<MockSystem> {
  const requests: MockRequest[] = [];
  const packages: Record<string, string> = { ZLOCAL: "ZLOCAL", ...(opts.packages ?? {}) };
  const refuse = opts.refusePackages ?? ["$TMP"];
  const components = opts.components === undefined ? ["ZLOCAL"] : opts.components;
  let repositoryPackage: string | null = null;

  const packageXml = (name: string, softwareComponent: string) =>
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<pak:package xmlns:pak="http://www.sap.com/adt/packages" xmlns:adtcore="http://www.sap.com/adt/core" ` +
    `adtcore:name="${name}" adtcore:type="DEVC/K" adtcore:description="${name}">` +
    `<pak:attributes pak:packageType="development" pak:isAddingObjectsAllowed="true" pak:recordChanges="false"/>` +
    `<pak:superPackage/>` +
    `<pak:applicationComponent pak:name=""/>` +
    `<pak:transport><pak:softwareComponent pak:name="${softwareComponent}"/><pak:transportLayer pak:name=""/></pak:transport>` +
    `</pak:package>`;

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const url = req.url ?? "";
      const pathOnly = url.split("?")[0];
      const body = Buffer.concat(chunks).toString("utf8");
      requests.push({ method: req.method ?? "", url, body, headers: req.headers });
      const tokenHeaders = {
        "content-type": "application/xml;charset=utf-8",
        "x-csrf-token": "TOKEN-123",
        "set-cookie": "SAP_SESSIONID_ABC=xyz; Path=/; HttpOnly"
      };

      // the token handshake, for both protocols
      if (req.method === "GET" && (pathOnly.endsWith("/$metadata") || pathOnly === "/sap/bc/adt/discovery")) {
        res.writeHead(200, tokenHeaders);
        res.end("<edmx:Edmx/>");
        return;
      }

      // --- ADT: software components ------------------------------------------------------------
      if (pathOnly.startsWith("/sap/bc/adt/packages/valuehelps/softwarecomponents")) {
        if (components === null) {
          res.writeHead(404, { "content-type": "text/plain" });
          res.end("not found");
          return;
        }
        const pattern = /[?&]name=([^&]*)/.exec(url)?.[1] ?? "";
        const names = pattern.startsWith("Z")
          ? components.filter((c) => c.startsWith("Z"))
          : pattern.startsWith("Y")
            ? components.filter((c) => c.startsWith("Y"))
            : components;
        const feed =
          `<?xml version="1.0" encoding="utf-8"?>` +
          `<nameditem:namedItemList xmlns:nameditem="http://www.sap.com/adt/nameditem">` +
          `<nameditem:totalItemCount>${names.length}</nameditem:totalItemCount>` +
          names.map((n) => `<nameditem:namedItem><nameditem:name>${n}</nameditem:name><nameditem:description/></nameditem:namedItem>`).join("") +
          `</nameditem:namedItemList>`;
        res.writeHead(200, { "content-type": NAMED_ITEMS_TYPE });
        res.end(feed);
        return;
      }

      // --- ADT: constraints (does a package here need a transport?) ----------------------------
      if (pathOnly === "/sap/bc/adt/packages/$constraints") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ changeRecording: { value: false }, packageTypes: { values: ["development"] } }));
        return;
      }

      // --- ADT: read a package ------------------------------------------------------------------
      if (req.method === "GET" && pathOnly.startsWith("/sap/bc/adt/packages/")) {
        const name = decodeURIComponent(pathOnly.slice("/sap/bc/adt/packages/".length));
        const softwareComponent = packages[name];
        if (!softwareComponent) {
          res.writeHead(404, { "content-type": "application/xml" });
          res.end(
            `<?xml version="1.0" encoding="utf-8"?><exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">` +
              `<message lang="EN">Error while importing object ${name} from the database</message></exc:exception>`
          );
          return;
        }
        res.writeHead(200, { "content-type": PACKAGE_TYPE });
        res.end(packageXml(name, softwareComponent));
        return;
      }

      // --- ADT: create a package ----------------------------------------------------------------
      if (req.method === "POST" && pathOnly === "/sap/bc/adt/packages") {
        if (components === null) {
          res.writeHead(404, { "content-type": "text/plain" });
          res.end("not found");
          return;
        }
        const name = /<pak:package[^>]*adtcore:name="([^"]*)"/.exec(body)?.[1] ?? "";
        const softwareComponent = /<pak:softwareComponent[^>]*pak:name="([^"]*)"/.exec(body)?.[1] ?? "";
        if (!name || !softwareComponent) {
          res.writeHead(400, { "content-type": "application/xml" });
          res.end(`<?xml version="1.0"?><exc:exception><message lang="EN">System expected the element 'superPackage'</message></exc:exception>`);
          return;
        }
        packages[name] = softwareComponent;
        res.writeHead(201, { "content-type": PACKAGE_TYPE });
        res.end(packageXml(name, softwareComponent));
        return;
      }

      // --- the UI5 repository service ------------------------------------------------------------
      if (req.method === "GET" && pathOnly.startsWith("/sap/opu/odata/UI5/ABAP_REPOSITORY_SRV/Repositories(")) {
        if (repositoryPackage) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ d: { Name: "ZDEPLOYED_APP", Package: repositoryPackage } }));
        } else {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { code: "not_found", message: { value: "not deployed" } } }));
        }
        return;
      }
      const csrfBroken =
        req.headers["x-csrf-token"] !== "TOKEN-123" || !/SAP_SESSIONID_ABC=xyz/.test(req.headers.cookie ?? "");
      if ((req.method === "POST" || req.method === "PUT") && pathOnly.includes("/Repositories") && csrfBroken) {
        res.writeHead(403, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { code: "CSRF", message: { value: "CSRF token validation failed" } } }));
        return;
      }
      if (req.method === "POST" && url.includes("/Repositories?")) {
        const sent = /<d:Package>([^<]*)<\/d:Package>/.exec(body)?.[1] ?? "";
        if (refuse.includes(sent)) {
          res.writeHead(400, {
            "content-type": "application/json",
            "sap-message": JSON.stringify({ code: "/UI5/UI5_REP_LOAD/003", message: "You are not authorized to create" })
          });
          res.end(
            JSON.stringify({
              error: {
                code: "/UI5/UI5_REP_LOAD/003",
                message: { lang: "en", value: "You are not authorized to create" },
                innererror: {
                  errordetails: [
                    { severity: "error", message: "You are not authorized to create" },
                    { severity: "info", message: "Upload canceled: SAPUI5 ABAP repository has not been created" }
                  ]
                }
              }
            })
          );
          return;
        }
        repositoryPackage = sent;
        res.writeHead(201, {
          "content-type": "application/atom+xml;charset=utf-8",
          "sap-message": JSON.stringify({ severity: "info", message: "BSP application created" })
        });
        res.end("<entry/>");
        return;
      }
      if (req.method === "PUT" && pathOnly.includes("/Repositories(")) {
        const sent = /<d:Package>([^<]*)<\/d:Package>/.exec(body)?.[1] ?? "";
        if (refuse.includes(sent)) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { code: "/UI5/UI5_REP_LOAD/003", message: { value: "refused" } } }));
          return;
        }
        repositoryPackage = sent;
        res.writeHead(200, { "content-type": "application/atom+xml;charset=utf-8" });
        res.end("<entry/>");
        return;
      }
      if (pathOnly.startsWith("/sap/bc/ui5_ui5/sap/")) {
        res.writeHead(200, { "content-type": "text/html;charset=utf-8" });
        res.end("<html><body>app</body></html>");
        return;
      }
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
}

describe("package recovery helpers", () => {
  it("names a package after the application, in the shape a customer component accepts", () => {
    expect(candidatePackageName("travelz")).toBe("ZTRAVELZ");
    expect(candidatePackageName("deployed-app")).toBe("ZDEPLOYED_APP");
    expect(candidatePackageName("/myco/travel")).toBe("ZTRAVEL");
    expect(candidatePackageName("")).toBe("ZAPP");
    expect(candidatePackageName("travelz", 1)).toBe("ZTRAVELZ_1");
    expect(candidatePackageName("A".repeat(40)).length).toBeLessThanOrEqual(30);
    expect(candidatePackageName("A".repeat(40), 2)).toMatch(/_2$/);
    expect(candidatePackageName("A".repeat(40), 2).length).toBeLessThanOrEqual(30);
  });

  it("builds the package entry ADT accepts, in the order it checks", () => {
    const payload = packageCreatePayload({ name: "ZMCPDEPLOY", superPackage: "ZLOCAL", softwareComponent: "ZLOCAL", recordChanges: false });
    expect(payload).toContain('adtcore:name="ZMCPDEPLOY"');
    expect(payload).toContain('<pak:superPackage adtcore:uri="/sap/bc/adt/packages/zlocal" adtcore:type="DEVC/K" adtcore:name="ZLOCAL"/>');
    expect(payload).toContain('<pak:softwareComponent pak:name="ZLOCAL"/>');
    expect(payload).toContain('pak:recordChanges="false"');
    // the server rejects the entry outright when an element is out of order
    expect(payload.indexOf("<pak:attributes")).toBeLessThan(payload.indexOf("<pak:superPackage"));
    expect(payload.indexOf("<pak:superPackage")).toBeLessThan(payload.indexOf("<pak:transport>"));
    expect(payload.indexOf("<pak:useAccesses")).toBeLessThan(payload.indexOf("<pak:subPackages"));
    expect(packageCreatePayload({ name: "Z", superPackage: "ZLOCAL", softwareComponent: "ZLOCAL", recordChanges: true })).toContain(
      'pak:recordChanges="true"'
    );
    expect(/adtcore:description="([^"]*)"/.exec(payload)?.[1].length).toBeLessThanOrEqual(60);
  });

  it("recognises the refusal for a package the system cannot use", () => {
    expect(looksLikePackageRefusal('{"code":"/UI5/UI5_REP_LOAD/003","message":"You are not authorized to create"}')).toBe(true);
    expect(looksLikePackageRefusal("Upload canceled: SAPUI5 ABAP repository has not been created")).toBe(true);
    expect(looksLikePackageRefusal("No authorization to access Service")).toBe(false);
    expect(looksLikePackageRefusal("CSRF token validation failed")).toBe(false);
    expect(looksLikePackageRefusal("Payload too large")).toBe(false);
  });
});

describe("deploying when the system refuses the default package", () => {
  let system: MockSystem;
  let dataDir: string;
  let config: AppConfig;
  let appPath: string;
  let workDir: string;

  beforeAll(async () => {
    system = await startMockSystem({ refusePackages: ["$TMP", "ZCHOSEN"] });
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "fiori-mcp-package-"));
    dataDir = emptyDataDir();
    appPath = writeApp(workDir, `${system.origin}/odata/v4/`);
    config = testConfig([{ name: "MOCK", url: system.origin, user: "u", password: "p", client: "100" }], dataDir);
  });

  afterAll(async () => {
    await system.close();
    fs.rmSync(workDir, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("creates a package the system accepts and uploads again, without asking", async () => {
    const result = await deployFioriApp({ config, appPath, install: false, bootstrapCheck: false });

    expect(result.ok).toBe(true);
    expect(result.action).toBe("created");
    expect(result.bsp.package).toBe("ZDEPLOYED_APP");
    expect(result.warnings.join(" ")).toMatch(/refused package '\$TMP'/);
    expect(result.warnings.join(" ")).toMatch(/created for this application/);

    // the package went in over ADT, hanging from the component's generated package
    const create = system.requests.find((r) => r.method === "POST" && r.url.startsWith("/sap/bc/adt/packages"));
    expect(create, "the package was never created").toBeTruthy();
    expect(create!.headers["x-csrf-token"]).toBe("TOKEN-123"); // the handshake, not an open write
    expect(create!.body).toContain('adtcore:name="ZDEPLOYED_APP"');
    expect(create!.body).toContain('adtcore:name="ZLOCAL"');
    expect(create!.body).toContain('<pak:softwareComponent pak:name="ZLOCAL"/>');
    expect(create!.body.indexOf("<pak:attributes")).toBeLessThan(create!.body.indexOf("<pak:superPackage"));
    expect(create!.body.indexOf("<pak:superPackage")).toBeLessThan(create!.body.indexOf("<pak:transport>"));

    // the refused attempt and the one that went through, in that order
    const uploads = system.requests.filter((r) => r.method === "POST" && r.url.includes("/Repositories?"));
    expect(uploads).toHaveLength(2);
    expect(uploads[0].body).toContain("<d:Package>$TMP</d:Package>");
    expect(uploads[1].body).toContain("<d:Package>ZDEPLOYED_APP</d:Package>");
    // a package that does not record changes needs no transport request
    expect(uploads[1].url).not.toContain("TransportRequest");
    expect(result.verification).toMatchObject({ attempted: true, ok: true, status: 200 });
  });

  it("keeps that package for every later deploy instead of rediscovering it", async () => {
    const adtBefore = system.requests.filter((r) => r.url.includes("/adt/")).length;
    const result = await deployFioriApp({ config, appPath, install: false, bootstrapCheck: false, skipBuild: true });

    expect(result.action).toBe("updated");
    expect(result.ok).toBe(true);
    // the package comes from the repository itself: no ADT round trip at all
    expect(result.bsp.package).toBe("ZDEPLOYED_APP");
    expect(system.requests.filter((r) => r.url.includes("/adt/")).length).toBe(adtBefore);
    const put = system.requests.filter((r) => r.method === "PUT").pop();
    expect(put!.body).toContain("<d:Package>ZDEPLOYED_APP</d:Package>");
  });
});

describe("package recovery when the caller chose the package", () => {
  it("reports the refusal as it stands and touches nothing else", async () => {
    const system = await startMockSystem({ refusePackages: ["$TMP", "ZCHOSEN"] });
    const dataDir = emptyDataDir();
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "fiori-mcp-explicit-"));
    const config = testConfig([{ name: "MOCK", url: system.origin, user: "u", password: "p", client: "100" }], dataDir);
    const app = writeApp(workDir, `${system.origin}/odata/v4/`);

    await expect(
      deployFioriApp({ config, appPath: app, install: false, bootstrapCheck: false, abapPackage: "ZCHOSEN" })
    ).rejects.toThrow(/Upload of 'ZDEPLOYED_APP' failed \(HTTP 400\)/);
    // an explicit package is authoritative: no ADT call, no second attempt
    expect(system.requests.filter((r) => r.url.includes("/adt/"))).toHaveLength(0);
    expect(system.requests.filter((r) => r.method === "POST" && r.url.includes("/Repositories?"))).toHaveLength(1);

    await system.close();
    fs.rmSync(workDir, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
});

describe("package recovery when the system offers no package", () => {
  it("explains both refusals instead of hiding the first one", async () => {
    const system = await startMockSystem({ components: [] });
    const dataDir = emptyDataDir();
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "fiori-mcp-nopkg-"));
    const config = testConfig([{ name: "MOCK", url: system.origin, user: "u", password: "p", client: "100" }], dataDir);
    const app = writeApp(workDir, `${system.origin}/odata/v4/`);

    await expect(
      deployFioriApp({ config, appPath: app, install: false, bootstrapCheck: false })
    ).rejects.toThrow(/Recovering into another package failed as well:[\s\S]*no customer software component/);

    await system.close();
    fs.rmSync(workDir, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
});
