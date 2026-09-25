/**
 * Everything that is a pure transformation of the ABAP UI5 Repository contract: the BSP name the
 * system accepts, the Atom entry the service reads, the URL a deployed app ends up on, and the
 * UI5 bootstrap rewrite that makes that URL load a framework at all.
 *
 * The protocol mirrors SAP's own client (`@sap-ux/axios-extension`, Ui5AbapRepositoryService):
 * `POST /Repositories` to create, `PUT /Repositories('NAME')` to update, files inside a base64
 * zip under `ZipArchive`, and `/sap/bc/ui5_ui5/sap/<name>` as the runtime URL afterwards.
 */
import fs from "node:fs";
import path from "node:path";

/** The one service that stores UI5 applications in an ABAP system (S/4, ABAP Environment, BTP). */
export const REPOSITORY_SERVICE_PATH = "/sap/opu/odata/UI5/ABAP_REPOSITORY_SRV";

/** BSP names are ABAP identifiers: no dashes, and short. SAP's validator allows 15 without a namespace. */
const BSP_NAME_RE = /^[A-Za-z0-9_/]{1,15}$/;
const NAMESPACE_RE = /^\/[A-Za-z0-9_]{1,10}\/[A-Za-z0-9_]{1,15}$/;

/** Max length SAP's `validateAppDescription` accepts for the BSP description. */
export const DESCRIPTION_MAX = 60;

export interface BspNameResult {
  name: string;
  /** Set when the requested name had to be corrected to something the system accepts. */
  adjustedFrom?: string;
  warnings: string[];
}

/**
 * Turn an app name into a BSP name ABAP will take.
 *
 * Dashes and spaces are legal in a folder name but not in a BSP, and the URL is derived from the
 * name, so the sanitising has to be deterministic: same app, same BSP, every deploy.
 */
export function sanitizeBspName(raw: string): BspNameResult {
  const warnings: string[] = [];
  const original = String(raw ?? "").trim();
  let name = original
    .replace(/[^A-Za-z0-9_/]/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
  if (!name) {
    name = "ZAPP";
    warnings.push(`'${original}' has no usable characters; using BSP name ZAPP.`);
  }
  if (!/^[A-Za-z]/.test(name)) name = `Z${name}`;
  if (!/^[ZY]/.test(name)) name = `Z${name}`;
  if (name.length > 15) {
    warnings.push(`BSP name '${name}' exceeds the 15 characters ABAP allows; truncated.`);
    name = name.slice(0, 15).replace(/_+$/, "");
  }
  if (!BSP_NAME_RE.test(name)) throw new Error(`Cannot derive a valid BSP name from '${original}' (tried '${name}').`);
  const adjustedFrom = name !== original && original ? original : undefined;
  return { name, adjustedFrom, warnings };
}

/** Validate an explicitly requested BSP name (a namespace `/ns/name` is accepted as SAP does). */
export function validateBspName(name: string): void {
  const value = String(name ?? "").trim();
  if (!NAMESPACE_RE.test(value) && !BSP_NAME_RE.test(value)) {
    throw new Error(
      `Invalid BSP name '${name}'. Use 1-15 characters from A-Z, 0-9 and _ (optionally prefixed with Z or Y), ` +
        `or a namespace form /namespace/name.`
    );
  }
}

function xml(value: string): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export interface RepositoryPayloadParams {
  /** Service root, used as xml:base. */
  serviceUrl: string;
  name: string;
  description: string;
  abapPackage: string;
  /** Raw zip bytes of the application. */
  zip: Buffer;
}

/** The Atom entry `POST /Repositories` and `PUT /Repositories('NAME')` expect. */
export function repositoryPayload(p: RepositoryPayloadParams): string {
  const entry = `${p.serviceUrl.replace(/\/$/, "")}/Repositories('${p.name}')`;
  return (
    `<entry xmlns="http://www.w3.org/2005/Atom" ` +
    `xmlns:m="http://schemas.microsoft.com/ado/2007/08/dataservices/metadata" ` +
    `xmlns:d="http://schemas.microsoft.com/ado/2007/08/dataservices" ` +
    `xml:base="${xml(p.serviceUrl.replace(/\/$/, ""))}">` +
    `<id>${xml(entry)}</id>` +
    `<title type="text">Repositories('${xml(p.name)}')</title>` +
    `<updated>${new Date().toISOString().replace(/\.\d{3}Z$/, ".000Z")}</updated>` +
    `<category term="/UI5/ABAP_REPOSITORY_SRV.Repository" scheme="http://schemas.microsoft.com/ado/2007/08/dataservices/scheme"/>` +
    `<link href="Repositories('${xml(p.name)}')" rel="edit" title="Repository"/>` +
    `<content type="application/xml"><m:properties>` +
    `<d:Name>${xml(p.name)}</d:Name>` +
    `<d:Package>${xml(p.abapPackage)}</d:Package>` +
    `<d:Description>${xml(p.description)}</d:Description>` +
    `<d:ZipArchive>${p.zip.toString("base64")}</d:ZipArchive>` +
    `<d:Info/>` +
    `</m:properties></content>` +
    `</entry>`
  );
}

/** ABAP serves the UI5 repository under `.abap-web.`; `.abap.` is the technical host (ADT/API). */
const ABAP_HOST_MAP: [RegExp, string][] = [
  [/\.abap\./, ".abap-web."],
  [/-api\./, "."],
  [/\.abap-?\d*\./, ".abap-web."]
];

/**
 * The URL a deployed app is browsed on.
 *
 * `name` alone is not enough: an ABAP Environment instance has a technical host and a web host,
 * and only the latter answers a browser.
 */
export function frontendAppUrl(baseUrl: string, name: string, client?: string): string {
  const url = new URL(baseUrl);
  for (const [pattern, replacement] of ABAP_HOST_MAP) url.hostname = url.hostname.replace(pattern, replacement);
  const pathName = name.startsWith("/") ? name.toLowerCase() : `/sap/${name.toLowerCase()}`;
  url.pathname = `/sap/bc/ui5_ui5${pathName}`;
  url.search = "";
  url.hash = "";
  if (client) url.searchParams.set("sap-client", client);
  return url.toString();
}

/** Roots where an ABAP system may serve the UI5 framework, most specific first. */
export const LOCAL_RESOURCE_ROOTS = [
  "/sap/bc/ui5_ui5/ui2/ushell/resources",
  "/sap/bc/ui5_ui5/resources"
];

export interface BootstrapRewrite {
  html: string;
  from: string;
  to: string;
  changed: boolean;
}

export interface BootstrapOptions {
  /** "cdn": ui5.sap.com pinned to the app's version. "local": the system's own resources. "keep": untouched. */
  mode: "cdn" | "local" | "keep";
  /** Required when mode is "local" and the caller already probed which root answers. */
  localRoot?: string;
  /** UI5 version to pin on the CDN, from ui5.yaml or the manifest. */
  version?: string;
}

const BOOTSTRAP_RE = /(<script[^>]*\bsrc\s*=\s*["'])([^"']*sap-ui-core\.js[^"']*)(["'])/i;

/**
 * Point `index.html` at a framework the browser can actually fetch.
 *
 * The generator writes `src="resources/sap-ui-core.js"`, which only resolves under `ui5 serve`.
 * Once the app sits behind `/sap/bc/ui5_ui5/sap/<bsp>/` that path 404s and the page stays blank,
 * so the archive shipped to ABAP must carry an absolute bootstrap instead.
 */
export function rewriteBootstrap(html: string, opts: BootstrapOptions): BootstrapRewrite {
  const match = BOOTSTRAP_RE.exec(html);
  if (!match) return { html, from: "", to: "", changed: false };
  const from = match[2];
  if (opts.mode === "keep") return { html, from, to: from, changed: false };
  const alreadyAbsolute = /^https?:\/\//i.test(from);
  if (opts.mode === "cdn" && alreadyAbsolute) return { html, from, to: from, changed: false };
  const to =
    opts.mode === "local" && opts.localRoot
      ? `${opts.localRoot.replace(/\/$/, "")}/sap-ui-core.js`
      : `https://ui5.sap.com${opts.version ? `/${opts.version}` : ""}/resources/sap-ui-core.js`;
  if (to === from) return { html, from, to, changed: false };
  return { html: html.replace(BOOTSTRAP_RE, `$1${to}$3`), from, to, changed: true };
}

/** UI5 version the app declares: manifest `minUI5Version` first, then ui5.yaml `framework.version`. */
export function appUi5Version(manifest: Record<string, unknown>, appRoot: string): string | undefined {
  const ui5 = manifest["sap.ui5"] as { dependencies?: { minUI5Version?: unknown } } | undefined;
  const min = ui5?.dependencies?.minUI5Version;
  if (typeof min === "string" && /^\d+\.\d+\.\d+$/.test(min)) return min;
  try {
    const yaml = fs.readFileSync(path.join(appRoot, "ui5.yaml"), "utf8");
    const m = /framework:[\s\S]*?version:\s*"?(\d+\.\d+\.\d+)"?/.exec(yaml);
    if (m) return m[1];
  } catch {
    /* no ui5.yaml: the CDN default (latest) is the only version there is */
  }
  return undefined;
}

/** Data sources the manifest declares, so the deploy target can be inferred from the app itself. */
export function manifestServiceUris(manifest: Record<string, unknown>): string[] {
  const ui5 = manifest["sap.ui5"] as Record<string, unknown> | undefined;
  const models = (ui5?.["models"] ?? {}) as Record<string, unknown>;
  const dataSources = ((manifest["sap.app"] as Record<string, unknown> | undefined)?.["dataSources"] ??
    {}) as Record<string, unknown>;
  const uris: string[] = [];
  for (const model of Object.values(models)) {
    const uri = (model as { uri?: unknown } | null)?.uri;
    if (typeof uri === "string") uris.push(uri);
  }
  for (const ds of Object.values(dataSources)) {
    const uri = (ds as { uri?: unknown } | null)?.uri;
    if (typeof uri === "string") uris.push(uri);
  }
  return uris.filter(Boolean);
}
