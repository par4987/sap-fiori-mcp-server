/**
 * Finding an ABAP package the system will accept, when the default one is refused.
 *
 * `$TMP` is where an application goes when the caller names no package: local, no transport, and
 * enough on most systems. An ABAP Environment instance refuses it — the repository loader answers
 * `/UI5/UI5_REP_LOAD/003`, "Upload canceled: SAPUI5 ABAP repository has not been created" — and
 * that reads exactly like a missing authorization, so without recovering the caller would conclude
 * that this user cannot deploy at all. (It is not that: the very same upload succeeds a moment
 * later once the application sits in a real package.)
 *
 * The way out is the Development Infrastructure the same instance exposes over ADT: the customer
 * software components it lists, the package generated beside each of them (`ZLOCAL` hangs the
 * `ZLOCAL` component), and the constraints that say whether a package would need a transport.
 * This module reads all that, names a package after the application and creates it — the shape
 * every `Z*` package in such a system already has: a child of the generated package, no change
 * recording, therefore no transport request.
 *
 * It only ever runs after a refusal, so a system that happily takes `$TMP` never sees a write here.
 */
import type { AppConfig } from "../config.js";
import { logger } from "../logger.js";
import { odataRequest, type ODataResponse } from "../odata/client.js";
import type { ODataTarget } from "../btp/destinations.js";

/** The package collection of ADT (Application Lifecycle Management / Development Infrastructure). */
export const ADT_PACKAGES_PATH = "/sap/bc/adt/packages";
const ADT_SOFTWARE_COMPONENTS_PATH = `${ADT_PACKAGES_PATH}/valuehelps/softwarecomponents`;
const ADT_CONSTRAINTS_PATH = `${ADT_PACKAGES_PATH}/$constraints`;
const ADT_DISCOVERY_PATH = "/sap/bc/adt/discovery";

const PACKAGE_MEDIA_TYPE = "application/vnd.sap.adt.packages.v2+xml";
const NAMED_ITEMS_MEDIA_TYPE = "application/vnd.sap.adt.nameditems.v1+xml";
const CONSTRAINTS_MEDIA_TYPE = "application/packageConstraints.v1+json";

/** ABAP package names are identifiers, and identifiers are 30 characters long. */
const PACKAGE_NAME_MAX = 30;
const PACKAGE_DESCRIPTION = "Deployed by sap-fiori-mcp-server";

export interface PackageChoice {
  /** Package the archive has to be uploaded into. */
  name: string;
  /** How this package was found: already there, created now, or the component's own package. */
  source: "existing" | "created" | "root";
  /** Package the choice hangs from, when it has one. */
  parent?: string;
}

export interface ResolvePackageOptions {
  target: ODataTarget;
  config: AppConfig;
  /** Name the package is derived from: the BSP, so package and application match. */
  preferredName: string;
  timeoutMs: number;
  /** A package that records changes needs a transport request, which only the caller can supply. */
  allowChangeRecording?: boolean;
}

interface PackageView {
  name: string;
  softwareComponent?: string;
}

interface AdtClient {
  get(path: string, accept: string): Promise<ODataResponse>;
  post(path: string, contentType: string, body: string): Promise<ODataResponse>;
}

/**
 * Why the repository refused the upload.
 *
 * The loader packs the real reason into its own log rather than into the message header, so both
 * the `sap-message` and the parsed error body have to be looked at.
 */
export function looksLikePackageRefusal(text: string): boolean {
  return (
    /\/UI5\/UI5_REP_LOAD\/003/.test(text) ||
    /Upload canceled/i.test(text) ||
    /has not been created/i.test(text) ||
    /not authorized to create/i.test(text) ||
    (/\bpackage\b/i.test(text) && /(not allowed|not permitted|cannot be used|invalid|refused)/i.test(text))
  );
}

function xml(value: string): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * The package name an application gets when it needs one.
 *
 * Deterministic (same app, same package, every deploy) and customer-shaped: `Z`/`Y` at the front,
 * because a customer software component will not take anything else.
 */
export function candidatePackageName(preferred: string, attempt = 0): string {
  const raw = String(preferred ?? "").trim();
  const lastSegment = raw.split("/").filter(Boolean).pop() ?? "";
  let name = lastSegment
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!name) name = "ZAPP";
  if (!/^[ZY]/.test(name)) name = `Z${name}`;
  if (attempt > 0) {
    const suffix = `_${attempt}`;
    name = `${name.slice(0, PACKAGE_NAME_MAX - suffix.length).replace(/_+$/, "")}${suffix}`;
  }
  return name.slice(0, PACKAGE_NAME_MAX);
}

/**
 * The `<pak:package>` entry ADT creates a package from.
 *
 * Element order is not free: the server answers "System expected the element '…superPackage'"
 * otherwise, so the payload mirrors what `GET /packages/<name>` returns for an existing package.
 */
export function packageCreatePayload(p: { name: string; superPackage: string; softwareComponent: string; recordChanges: boolean }): string {
  const uri = `${ADT_PACKAGES_PATH}/${p.superPackage.toLowerCase()}`;
  return (
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<pak:package xmlns:pak="http://www.sap.com/adt/packages" xmlns:adtcore="http://www.sap.com/adt/core" ` +
    `adtcore:name="${xml(p.name)}" adtcore:type="DEVC/K" adtcore:description="${xml(PACKAGE_DESCRIPTION)}" ` +
    `adtcore:masterLanguage="EN">` +
    `<pak:attributes pak:packageType="development" pak:recordChanges="${p.recordChanges ? "true" : "false"}"/>` +
    `<pak:superPackage adtcore:uri="${xml(uri)}" adtcore:type="DEVC/K" adtcore:name="${xml(p.superPackage)}"/>` +
    `<pak:applicationComponent pak:name=""/>` +
    `<pak:transport>` +
    `<pak:softwareComponent pak:name="${xml(p.softwareComponent)}"/>` +
    `<pak:transportLayer pak:name=""/>` +
    `</pak:transport>` +
    `<pak:useAccesses/><pak:packageInterfaces/><pak:subPackages/>` +
    `</pak:package>`
  );
}

/** ADT reports a failure as an `<exc:exception>` with a human sentence inside. */
function adtMessage(res: ODataResponse): string {
  const text = res.text.replace(/\s+/g, " ");
  const message = /<message[^>]*>([^<]*)<\/message>/.exec(text)?.[1];
  return `${message ?? text.slice(0, 240)} (HTTP ${res.status})`;
}

function adtClient(target: ODataTarget, config: AppConfig, timeoutMs: number): AdtClient {
  const origin = new URL(target.url).origin;
  const get = (path: string, accept: string) =>
    odataRequest({
      url: `${origin}${path}`,
      system: target.system,
      headers: target.headers,
      accept,
      timeoutMs,
      config,
      trustedUrls: target.trustedUrls
    });
  const post = (path: string, contentType: string, body: string) =>
    odataRequest({
      url: `${origin}${path}`,
      system: target.system,
      headers: { ...target.headers, "content-type": contentType },
      method: "POST",
      body,
      accept: PACKAGE_MEDIA_TYPE,
      // ADT validates the token against the session that asked for it, exactly as IWFND does
      csrf: true,
      csrfUrl: `${origin}${ADT_DISCOVERY_PATH}`,
      timeoutMs,
      config,
      trustedUrls: target.trustedUrls
    });
  return { get, post };
}

function namedItems(xmlText: string): string[] {
  return [...xmlText.matchAll(/<nameditem:name>([^<]*)<\/nameditem:name>/g)]
    .map((m) => m[1].trim())
    .filter(Boolean);
}

/**
 * Customer software components this instance will take a package into.
 *
 * `Z*` and `Y*` first (that is what a package named after a BSP will start with), and the whole
 * list only as a fallback. `LOCAL` is never useful: it takes `$`/`TEST` packages, whose creation
 * needs an authorization a developer usually does not have.
 */
async function softwareComponents(client: AdtClient): Promise<string[]> {
  const found: string[] = [];
  for (const pattern of ["Z*", "Y*"]) {
    const res = await client.get(`${ADT_SOFTWARE_COMPONENTS_PATH}?name=${pattern}`, NAMED_ITEMS_MEDIA_TYPE);
    if (res.status === 200) found.push(...namedItems(res.text));
  }
  if (!found.length) {
    const res = await client.get(ADT_SOFTWARE_COMPONENTS_PATH, NAMED_ITEMS_MEDIA_TYPE);
    if (res.status === 200) found.push(...namedItems(res.text).filter((name) => name !== "LOCAL"));
  }
  return [...new Set(found)].filter((name) => name !== "LOCAL");
}

async function readPackage(client: AdtClient, name: string): Promise<PackageView | null> {
  const res = await client.get(`${ADT_PACKAGES_PATH}/${encodeURIComponent(name)}`, PACKAGE_MEDIA_TYPE);
  if (res.status !== 200) return null;
  const opening = /<pak:package[\s\S]*?>/.exec(res.text)?.[0] ?? "";
  const own = /adtcore:name="([^"]*)"/.exec(opening)?.[1] ?? name;
  const softwareComponent = /<pak:softwareComponent[^>]*\bpak:name="([^"]*)"/.exec(res.text)?.[1];
  return { name: own, ...(softwareComponent ? { softwareComponent } : {}) };
}

/** Does a package of this shape record changes — and therefore demand a transport request? */
async function recordsChanges(client: AdtClient, name: string, softwareComponent: string): Promise<boolean | null> {
  const res = await client.get(
    `${ADT_CONSTRAINTS_PATH}?objname=${encodeURIComponent(name)}&swcomp=${encodeURIComponent(softwareComponent)}`,
    CONSTRAINTS_MEDIA_TYPE
  );
  if (res.status !== 200) return null;
  const value = (res.json as { changeRecording?: { value?: unknown } } | undefined)?.changeRecording?.value;
  return typeof value === "boolean" ? value : null;
}

async function createPackage(
  client: AdtClient,
  p: { name: string; superPackage: string; softwareComponent: string; recordChanges: boolean }
): Promise<{ created: PackageChoice } | { failed: string }> {
  const res = await client.post(ADT_PACKAGES_PATH, `${PACKAGE_MEDIA_TYPE}; charset=utf-8`, packageCreatePayload(p));
  if (res.status < 200 || res.status >= 300) return { failed: adtMessage(res) };
  const opening = /<pak:package[\s\S]*?>/.exec(res.text)?.[0] ?? "";
  const name = /adtcore:name="([^"]*)"/.exec(opening)?.[1] ?? p.name;
  return { created: { name, source: "created", parent: p.superPackage } };
}

/**
 * A package for this application, ready to receive the upload.
 *
 * Preference order: a package with the application's name that already exists, then a new one under
 * the software component's generated package, then that generated package itself. Only the second
 * step writes anything, and it is skipped entirely when the name is already taken.
 *
 * Throws with every reason collected along the way, so a caller can tell "no customer component
 * here" from "this user may not create packages" from "that component needs a transport".
 */
export async function resolveWritablePackage(opts: ResolvePackageOptions): Promise<PackageChoice> {
  const client = adtClient(opts.target, opts.config, opts.timeoutMs);
  const notes: string[] = [];
  const roots: PackageView[] = [];

  const components = await softwareComponents(client);
  if (!components.length) {
    throw new Error(
      "the system lists no customer software component (ADT /sap/bc/adt/packages/valuehelps/softwarecomponents), " +
        "so it offers no package this application could be created in. Pass `package` — and `transport` when the " +
        "target records changes."
    );
  }

  for (const softwareComponent of components) {
    const root = await readPackage(client, softwareComponent);
    if (!root) {
      notes.push(`${softwareComponent}: the system has no package ${softwareComponent} to create a child package under.`);
      continue;
    }

    // Change recording is a property of the component, so asking once with the name the package
    // would get settles whether this route can work at all: a package that records changes demands
    // a transport request, and only the caller can name one.
    const recording = await recordsChanges(client, candidatePackageName(opts.preferredName), softwareComponent);
    if (recording && !opts.allowChangeRecording) {
      notes.push(`${softwareComponent}: packages there record changes, so they need a transport request (pass \`transport\`).`);
      continue;
    }

    for (let attempt = 0; attempt < 3; attempt++) {
      const candidate = candidatePackageName(opts.preferredName, attempt);
      const existing = await readPackage(client, candidate);
      if (existing) {
        if (!existing.softwareComponent || existing.softwareComponent === softwareComponent) {
          logger.info("deploy: reusing package", { package: existing.name, softwareComponent });
          return { name: existing.name, source: "existing", parent: root.name };
        }
        continue; // the name is taken by a package of another component: try the next one
      }

      const result = await createPackage(client, {
        name: candidate,
        superPackage: root.name,
        softwareComponent,
        recordChanges: recording === true
      });
      if ("created" in result) {
        logger.info("deploy: created package", { package: result.created.name, superPackage: root.name, softwareComponent });
        return result.created;
      }
      notes.push(`${candidate} under ${root.name} (${softwareComponent}): ${result.failed}`);
      // "provided repository", "software component not modifiable", "not a valid software
      // component" and friends are about the component, not the name: move on to the next one
      if (/(provided repository|software component|TR458|TR463|not modifiable)/i.test(result.failed)) break;
    }
    // Nothing new could be created, but this component does hold packages: its own package is the
    // next best place for the application, and using it costs no write at all.
    roots.push(root);
  }

  if (roots.length) {
    logger.warn("deploy: using the component's own package", { package: roots[0].name, notes });
    return { name: roots[0].name, source: "root" };
  }

  throw new Error(notes.length ? notes.join("; ") : "no package could be created on the target system.");
}
