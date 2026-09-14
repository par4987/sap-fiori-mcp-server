import path from "node:path";
import { resolvePath, writeFileSafe, exists } from "../util/fs.js";
import { feComponentJs, feI18n, feIndexHtml, feManifest, feMetadataPlaceholder, fePackageJson, feUi5Yaml, type FeAppOptions, type Floorplan } from "./templates.js";
import { parseEdmx, findEntityType, type EdmxModel } from "../odata/edmx.js";
import { readText } from "../util/fs.js";
import { logger } from "../logger.js";

/**
 * Normalize namespace/app id: reverse domain, dots allowed, no dashes.
 *
 * Both halves need sanitising, not just the namespace. A folder may be called `travel-lr`, but a
 * UI5 component id may not: the hyphen makes `sap.app/id` illegal, and the app this generator
 * writes would then be rejected by the manifest validation it ships with. Underscores go too —
 * legal, but they draw a warning, and a generated app should come out clean.
 */
export function normalizeAppId(input: string, appName: string): { namespace: string; appId: string } {
  let ns = (input || "ns").trim().toLowerCase().replace(/[^a-z0-9.]/g, "");
  if (!ns) ns = "ns";
  if (/^\d/.test(ns)) ns = `ns.${ns}`;
  let name = (appName || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!name) name = "app";
  // a segment starting with a digit is legal deeper in the id, but reads as a mistake
  if (/^\d/.test(name)) name = `app${name}`;
  return { namespace: ns, appId: `${ns}.${name}` };
}

/**
 * A UI.LineItem term, however the document spells it.
 *
 * The same annotation arrives as `UI.LineItem`, as an alias the service picked for itself
 * (`SAP__UI.LineItem`), or fully qualified (`com.sap.vocabularies.UI.v1.LineItem`). Matching only
 * the bare form finds nothing in a real ABAP service, which is exactly where this has to work.
 */
const isLineItem = (term: string): boolean => /(?:^|\.)[A-Za-z0-9_]*UI(?:\.v\d+)?\.LineItem$/.test(term);

/**
 * Which entity set the app should be built on when the caller did not name one.
 *
 * "The first set in the document" is arbitrary: a V4 service lists Booking before Travel, and the
 * generated app then opened on the item rather than the thing that owns it. The metadata already
 * says which sets are meant to be shown — a list needs UI.LineItem, and a set without it was never
 * going to render a table — so those are the candidates.
 *
 * Several may qualify, as in a travel service where both the trip and its bookings are listable.
 * A draft-enabled service names its root outright (Common.DraftRoot against the container entry,
 * DraftNode against the children), so that decides it. Failing that, the root of the composition is
 * the candidate no other candidate navigates to — which settles the common parent/child pair but
 * not a service whose child points back at its parent, and there the document order stands.
 */
export function pickMainEntitySet(model: EdmxModel): string | undefined {
  const short = (qualified: string): string => qualified.split("/")[0].split(".").pop() ?? qualified;
  const listable = new Set(
    model.annotations.filter((a) => a.terms.some((t) => isLineItem(t.term))).map((a) => short(a.target))
  );
  const candidates = model.entitySets.filter((set) => listable.has(short(set.entityType)));
  if (!candidates.length) return undefined;

  // the container entry is targeted as '<alias>.Container/<set>', so the set name is the last segment
  const draftRoots = new Set(
    model.annotations
      .filter((a) => a.terms.some((t) => /(?:^|\.)[A-Za-z0-9_]*[Cc]ommon\.DraftRoot$/.test(t.term)))
      .map((a) => a.target.split("/").pop() ?? "")
  );
  const declaredRoot = candidates.find((c) => draftRoots.has(c.name));
  if (declaredRoot) return declaredRoot.name;

  const names = new Set(candidates.map((c) => c.name));
  const reachable = new Set<string>();
  for (const c of candidates) {
    for (const target of Object.values(c.navigations)) {
      if (target !== c.name && names.has(target)) reachable.add(target);
    }
  }
  const roots = candidates.filter((c) => !reachable.has(c.name));
  return (roots[0] ?? candidates[0]).name;
}

export interface GenerateResult {
  appPath: string;
  files: string[];
  warnings: string[];
}

/** Floorplans that support Flexible Column Layout (FCL is invalid for the others). */
export function floorplanSupportsFcl(fp: Floorplan): boolean {
  return fp === "list-report" || fp === "worklist";
}

/** Validate the floorplan/odataVersion combination; downgrades with a warning when unsupported. */
export function resolveFloorplan(floorplan: Floorplan, odataVersion: "2.0" | "4.0", warnings: string[]): Floorplan {
  let fp = floorplan;
  if (fp === "object-page" && odataVersion !== "4.0") {
    warnings.push("Floorplan 'object-page' (form entry) requires OData V4 (sap.fe.templates); falling back to 'list-report'.");
    fp = "list-report";
  }
  if (fp === "analytical-list-page" && odataVersion !== "2.0") {
    warnings.push("Floorplan 'analytical-list-page' is only available for OData V2 (sap.suite.ui.generic.template); falling back to 'list-report'.");
    fp = "list-report";
  }
  if (fp === "overview-page" && odataVersion !== "2.0") {
    warnings.push("Floorplan 'overview-page' (sap.ovp) is only available for OData V2; falling back to 'list-report'.");
    fp = "list-report";
  }
  return fp;
}

/** Generate a Fiori elements app into targetPath (CAP app folder or standalone workspace). */
export async function generateFioriApp(params: {
  targetPath: string;
  appName: string;
  title: string;
  description?: string;
  namespace?: string;
  entitySet?: string;
  metadataXmlPath?: string;
  metadataXml?: string;
  serviceUrl?: string;
  odataVersion?: "2.0" | "4.0";
  floorplan?: Floorplan;
  addFcl?: boolean;
  initialLoad?: boolean;
  isCap: boolean;
}): Promise<GenerateResult> {
  const warnings: string[] = [];
  const root = resolvePath(params.targetPath);
  const appFolderName = params.appName.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase();
  const appPath = params.isCap ? path.join(root, "app", appFolderName) : path.join(root, appFolderName);
  if (exists(appPath)) throw new Error(`Target app folder already exists: ${appPath}`);

  // resolve entity set + metadata
  let metadataXml = params.metadataXml;
  if (!metadataXml && params.metadataXmlPath) {
    metadataXml = readText(resolvePath(params.metadataXmlPath));
  }
  let entitySet = params.entitySet;
  let mainEntity = entitySet ?? "";
  if (metadataXml) {
    const model = parseEdmx(metadataXml);
    if (!entitySet) entitySet = pickMainEntitySet(model) ?? model.entitySets[0]?.name;
    if (!entitySet) {
      warnings.push("Metadata contains no entity sets; generated app uses a placeholder entitySet 'Main'. Update manifest.json afterwards.");
      entitySet = "Main";
    }
    mainEntity = model.entityTypes.find((t) => t.name === entitySet)?.name ?? findEntityType(model, entitySet)?.name ?? entitySet;
  } else if (!entitySet) {
    warnings.push("No metadata and no entitySet provided; using placeholder entitySet 'Main'. Run download_odata_service_metadata and update the manifest.");
    entitySet = "Main";
  }

  // CAP convention: app data source is relative "/<service>/"; detect service path from CAP srv if possible
  let serviceUri = params.serviceUrl ?? "";
  if (!serviceUri) {
    serviceUri = params.isCap ? "/service-root/" : "/sap/opu/odata4/";
    warnings.push(
      `serviceUri guessed as "${serviceUri}". Pass serviceUrl, or the destination/systemName plus servicePath that the service lives at, ` +
        "and it will be written correctly; otherwise adjust sap.app/dataSources/mainService/uri in manifest.json by hand."
    );
  }

  // a service root ends in a slash: UI5 appends the entity set to it, and the manifest check this
  // tool ships with says so. A URL that named a document rather than a root keeps its shape.
  if (serviceUri && !serviceUri.endsWith("/") && !serviceUri.includes(".svc") && !serviceUri.includes("$") && !serviceUri.includes("?")) {
    serviceUri = `${serviceUri}/`;
  }

  const odataVersion: "2.0" | "4.0" =
    params.odataVersion ?? (metadataXml ? parseEdmx(metadataXml).version : "4.0");

  const requestedFloorplan: Floorplan = params.floorplan ?? "list-report";
  const floorplan = resolveFloorplan(requestedFloorplan, odataVersion, warnings);
  if (params.addFcl && !floorplanSupportsFcl(floorplan)) {
    warnings.push(`Flexible Column Layout is not supported by the '${floorplan}' floorplan; FCL disabled.`);
  }

  const { appId } = normalizeAppId(params.namespace ?? (params.isCap ? "cap.app" : "ns"), appFolderName);

  const options: FeAppOptions = {
    namespace: appId.split(".").slice(0, -1).join("."),
    appId,
    appName: appFolderName,
    title: params.title,
    description: params.description,
    entitySet,
    mainEntity,
    odataVersion,
    serviceUri,
    addFcl: floorplanSupportsFcl(floorplan) ? !!params.addFcl : false,
    floorplan,
    initialLoad: params.initialLoad
  };

  const files: Record<string, string> = {
    "webapp/manifest.json": feManifest(options),
    "webapp/Component.js": feComponentJs(options),
    "webapp/index.html": feIndexHtml(options),
    "webapp/i18n/i18n.properties": feI18n(options),
    "ui5.yaml": feUi5Yaml(options, params.isCap),
    "package.json": fePackageJson(options, params.isCap)
  };
  if (metadataXml) {
    files["webapp/localService/metadata.xml"] = metadataXml;
  } else {
    files["webapp/localService/metadata.xml"] = feMetadataPlaceholder();
  }

  for (const [rel, content] of Object.entries(files)) {
    writeFileSafe(path.join(appPath, rel), content);
  }
  logger.info("generateFioriApp done", { appPath, entitySet, odataVersion, floorplan });

  return { appPath, files: Object.keys(files).map((f) => path.join(appPath, f)), warnings };
}
