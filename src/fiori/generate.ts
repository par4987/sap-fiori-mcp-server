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
const uiTerm = (name: string): RegExp => new RegExp(`(?:^|\.)[A-Za-z0-9_]*UI(?:\.v\d+)?\.${name}$`);
const isLineItem = (term: string): boolean => uiTerm("LineItem").test(term);

/**
 * A term that only a business entity gets: the header and facets of an object page.
 *
 * A value help carries UI.LineItem too — it needs a table for its popup — so LineItem alone picks
 * out the status code list as readily as the travel it belongs to. Nobody writes an object page for
 * a value help, which is what makes this the line between them.
 */
const hasObjectPage = (terms: string[]): boolean =>
  terms.some((t) => uiTerm("HeaderInfo").test(t) || uiTerm("Facets").test(t));

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
/**
 * A CDS with parameters, as OData exposes it.
 *
 * The entity set holds the parameters, not the rows: its type is `<Name>Parameters`, and a single
 * navigation — `Set` by convention — leads to the result the annotations describe. An app therefore
 * opens on `Entity(p1=…,p2=…)/Set`, and a generator that stops at the entity set builds a list of
 * parameter records nobody can use.
 */
export interface ParameterizedEntity {
  /** The parameter entity set, e.g. InterfaceStatistics. */
  entitySet: string;
  /** The navigation that leads to the rows, e.g. Set. */
  navigation: string;
  /** The parameters the service will demand, in declaration order. */
  parameters: string[];
  /** Short name of the result entity type, which is what the annotations target. */
  resultType: string;
}

const shortName = (qualified: string): string =>
  (qualified.replace(/^Collection\(/, "").replace(/\)$/, "").split("/")[0].split(".").pop() ?? qualified);

/** The parameterised shape of an entity set, or null when it is an ordinary one. */
export function parameterizedEntity(model: EdmxModel, entitySetName: string): ParameterizedEntity | null {
  const set = model.entitySets.find((s) => s.name === entitySetName);
  if (!set) return null;
  const type = model.entityTypes.find((t) => t.name === shortName(set.entityType));
  if (!type || !/Parameters$/.test(type.name)) return null;
  // 'Set' is the name ABAP gives it; fall back to the only navigation when a service differs
  const nav = type.navigationProperties.find((n) => n.name === "Set") ?? (type.navigationProperties.length === 1 ? type.navigationProperties[0] : undefined);
  if (!nav?.type) return null;
  return { entitySet: set.name, navigation: nav.name, parameters: type.properties.map((p) => p.name), resultType: shortName(nav.type) };
}

export function pickMainEntitySet(model: EdmxModel): string | undefined {
  const short = (qualified: string): string => qualified.split("/")[0].split(".").pop() ?? qualified;
  const listable = new Set(
    model.annotations.filter((a) => a.terms.some((t) => isLineItem(t.term))).map((a) => short(a.target))
  );
  const termsByType = new Map<string, string[]>();
  for (const a of model.annotations) {
    const key = short(a.target);
    termsByType.set(key, [...(termsByType.get(key) ?? []), ...a.terms.map((t) => t.term)]);
  }

  const listables = model.entitySets.filter((set) => {
    if (listable.has(short(set.entityType))) return true;
    // a parameterised set is annotated on the far side of its navigation
    const p = parameterizedEntity(model, set.name);
    return !!p && listable.has(p.resultType);
  });
  if (!listables.length) return undefined;
  // value helps are listable but are not what an app opens on; keep them only if nothing else is left
  const typeOf = (set: (typeof listables)[number]): string => parameterizedEntity(model, set.name)?.resultType ?? short(set.entityType);
  const withPage = listables.filter((set) => hasObjectPage(termsByType.get(typeOf(set)) ?? []));
  const candidates = withPage.length ? withPage : listables;

  // the container entry is targeted as '<alias>.Container/<set>', so the set name is the last segment
  const draftRoots = new Set(
    model.annotations
      .filter((a) => a.terms.some((t) => /(?:^|\.)[A-Za-z0-9_]*[Cc]ommon\.DraftRoot$/.test(t.term)))
      .map((a) => a.target.split("/").pop() ?? "")
  );
  const declaredRoot = candidates.find((c) => draftRoots.has(c.name));
  if (declaredRoot) return declaredRoot.name;

  // a filter bar belongs to the page an app opens on, and a child list never gets one
  const filtered = candidates.find((c) => (termsByType.get(typeOf(c)) ?? []).some((t) => uiTerm("SelectionFields").test(t)));
  if (filtered) return filtered.name;

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
  /**
   * Annotation documents belonging to the service. A V2 service keeps its UI annotations outside
   * $metadata, and without them a generated list report has nothing to put in its columns.
   */
  annotationDocuments?: { technicalName: string; url: string; xml: string }[];
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
  let parameters: ParameterizedEntity | undefined;
  const annotationDocs = (params.annotationDocuments ?? []).filter((a) => a.xml.trim());
  if (metadataXml) {
    const model = parseEdmx(metadataXml);
    // the sets live in $metadata, the terms that mark them listable may not: merge before choosing
    const annotated: EdmxModel = {
      ...model,
      annotations: [...model.annotations, ...annotationDocs.flatMap((a) => parseEdmx(a.xml).annotations)]
    };
    if (!entitySet) entitySet = pickMainEntitySet(annotated) ?? model.entitySets[0]?.name;
    if (!entitySet) {
      warnings.push("Metadata contains no entity sets; generated app uses a placeholder entitySet 'Main'. Update manifest.json afterwards.");
      entitySet = "Main";
    }
    // a parameterised set is named for its parameters; the pages are about the result type
    parameters = parameterizedEntity(model, entitySet) ?? undefined;
    mainEntity = parameters
      ? parameters.resultType.replace(/Type$/, "")
      : (model.entityTypes.find((t) => t.name === entitySet)?.name ?? findEntityType(model, entitySet)?.name ?? entitySet);
    if (parameters) {
      warnings.push(
        `'${entitySet}' is a CDS with parameters (${parameters.parameters.join(", ")}); the app is built on ` +
          `${entitySet}/${parameters.navigation} and sap.fe will ask for them before loading data.`
      );
    }
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

  const annotationFiles = annotationDocs.map((a) => {
    const safe = a.technicalName.replace(/[^A-Za-z0-9._-]/g, "_") || "annotations";
    return { name: safe, uri: a.url, localUri: `localService/${safe}.xml`, xml: a.xml };
  });

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
    initialLoad: params.initialLoad,
    annotations: annotationFiles.map(({ name, uri, localUri }) => ({ name, uri, localUri })),
    parameters: parameters ? { entitySet: parameters.entitySet, navigation: parameters.navigation, keys: parameters.parameters } : undefined
  };

  const files: Record<string, string> = {
    "webapp/manifest.json": feManifest(options),
    "webapp/Component.js": feComponentJs(options),
    "webapp/index.html": feIndexHtml(options),
    "webapp/i18n/i18n.properties": feI18n(options),
    "ui5.yaml": feUi5Yaml(options, params.isCap),
    "package.json": fePackageJson(options, params.isCap)
  };
  for (const a of annotationFiles) {
    files[`webapp/${a.localUri}`] = a.xml;
  }
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
