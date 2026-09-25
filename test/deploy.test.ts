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
