import path from "node:path";
import { readAppManifest } from "../fiori/apps.js";
import { resolvePath, exists, tryReadJson, relativePath } from "../util/fs.js";

export interface ValidationIssue {
  severity: "error" | "warning";
  rule: string;
  message: string;
  path?: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: number;
  warnings: number;
  issues: ValidationIssue[];
  manifestPath: string;
}

const ID_RE = /^[a-zA-Z][a-zA-Z0-9._]*$/;

/** Validate a manifest.json (application or card) with UI5-specific rules. */
export function validateManifest(appPathOrManifest: string): ValidationResult {
  const issues: ValidationIssue[] = [];
  let root = resolvePath(appPathOrManifest);
  let found = readAppManifest(root);
  // accept a direct path to manifest.json too
  if (!found && appPathOrManifest.endsWith("manifest.json")) {
    root = path.dirname(resolvePath(appPathOrManifest));
    const m = tryReadJson<Record<string, unknown>>(resolvePath(appPathOrManifest));
    if (m) found = { manifest: m, manifestPath: resolvePath(appPathOrManifest), webappDir: root };
  }
  if (!found) throw new Error(`No manifest.json found at or under ${appPathOrManifest}`);
  const { manifest, manifestPath, webappDir } = found;

  const sapApp = (manifest["sap.app"] ?? null) as Record<string, unknown> | null;
  /** The app id doubles as the module namespace of webapp/, so view names resolve against it. */
  const appId = String(sapApp?.["id"] ?? "");
  const sapUi = (manifest["sap.ui"] ?? null) as Record<string, unknown> | null;
  const sapUi5 = (manifest["sap.ui5"] ?? null) as Record<string, unknown> | null;

  if (!sapApp) issues.push({ severity: "error", rule: "sap.app.required", message: "Section sap.app is missing" });
  if (!sapUi5 && sapApp?.["type"] === "application") issues.push({ severity: "error", rule: "sap.ui5.required", message: "Section sap.ui5 is missing for an application" });

  if (sapApp) {
    const id = String(sapApp["id"] ?? "");
    if (!id) issues.push({ severity: "error", rule: "sap.app.id.required", message: "sap.app/id is required" });
    else {
      if (!ID_RE.test(id)) issues.push({ severity: "error", rule: "sap.app.id.pattern", message: `sap.app/id '${id}' contains invalid characters (allowed: letters, digits, dots; must start with a letter)` });
      if (/_/.test(id)) issues.push({ severity: "warning", rule: "sap.app.id.no-underscore", message: `sap.app/id '${id}' contains an underscore — avoid underscores in UI5 component ids` });
      if (!id.includes(".")) issues.push({ severity: "warning", rule: "sap.app.id.reverse-domain", message: `sap.app/id '${id}' should use a reverse-domain namespace, e.g. 'my.company.app'` });
      if (/^\d/.test(id.split(".")[0])) issues.push({ severity: "error", rule: "sap.app.id.first-char", message: "First namespace segment of sap.app/id must not start with a digit" });
    }
    const type = String(sapApp["type"] ?? "");
    const validTypes = ["application", "card", "component", "library", "theme-package", "extension", "test-suite"];
    if (!validTypes.includes(type)) issues.push({ severity: "error", rule: "sap.app.type", message: `sap.app/type '${type}' is invalid. Expected one of: ${validTypes.join(", ")}` });

    const ds = (sapApp["dataSources"] ?? {}) as Record<string, Record<string, unknown>>;
    for (const [name, d] of Object.entries(ds)) {
      if (String(d["type"] ?? "") === "OData") {
        const settings = (d["settings"] ?? {}) as Record<string, unknown>;
        const v = String(settings["odataVersion"] ?? "");
        if (v && !["2.0", "4.0"].includes(v)) issues.push({ severity: "error", rule: "dataSource.odataVersion", message: `dataSources/${name}: odataVersion must be 2.0 or 4.0`, path: `sap.app/dataSources/${name}` });
        if (!d["uri"] && !settings["localUri"]) issues.push({ severity: "warning", rule: "dataSource.uri", message: `dataSources/${name} has no uri/localUri`, path: `sap.app/dataSources/${name}` });
        const uri = String(d["uri"] ?? "");
        if (uri && !uri.endsWith("/") && !uri.includes(".svc") && !uri.includes("$")) {
          issues.push({ severity: "warning", rule: "dataSource.uri.trailing-slash", message: `dataSources/${name} uri '${uri}' usually ends with '/' for V4 services`, path: `sap.app/dataSources/${name}` });
        }
      }
      if (String(d["type"] ?? "") === "ODataAnnotation" && !d["uri"] && !(d["settings"] as Record<string, unknown>)?.["localUri"]) {
        issues.push({ severity: "error", rule: "annotation.uri", message: `Annotation dataSource '${name}' needs uri or settings.localUri`, path: `sap.app/dataSources/${name}` });
      }
    }
  }

  if (sapUi5 && sapApp?.["type"] === "application") {
    // rootView
    const rootView = sapUi5["rootView"] as Record<string, unknown> | undefined;
    const isFe = JSON.stringify(manifest).includes("sap.fe.templates") || JSON.stringify(manifest).includes("sap.suite.ui.generic.template");
    if (!rootView && !isFe) {
      issues.push({ severity: "warning", rule: "sap.ui5.rootView", message: "No rootView defined (only acceptable with Component-based Fiori elements apps)" });
    }
    if (rootView && typeof rootView["viewName"] === "string") {
      const viewName = String(rootView["viewName"]);
      if (!isFe) checkViewExists(webappDir, appId, viewName, issues, "sap.ui5.rootView");
    }

    // dependencies
    const deps = (sapUi5["dependencies"] ?? {}) as Record<string, unknown>;
    const min = deps["minUI5Version"];
    if (!min) issues.push({ severity: "warning", rule: "dependencies.minUI5Version", message: "dependencies/minUI5Version is recommended" });
    else if (!/^\d+\.\d+\.\d+/.test(String(min))) issues.push({ severity: "error", rule: "dependencies.minUI5Version.format", message: `minUI5Version '${min}' is not a valid version` });
    const libs = (deps["libs"] ?? {}) as Record<string, unknown>;
    if (!libs["sap.m"] && !libs["sap.ui.core"]) issues.push({ severity: "warning", rule: "dependencies.libs", message: "Common libraries (sap.m) not declared in dependencies" });

    // models
    const models = (sapUi5["models"] ?? {}) as Record<string, Record<string, unknown>>;
    const ds = (sapApp["dataSources"] ?? {}) as Record<string, Record<string, unknown>>;
    for (const [name, model] of Object.entries(models)) {
      if (model["dataSource"]) {
        const dsName = String(model["dataSource"]);
        if (!ds[dsName]) issues.push({ severity: "error", rule: "models.dataSource.missing", message: `Model '${name}' references dataSource '${dsName}' which is not defined in sap.app/dataSources`, path: `sap.ui5/models/${name}` });
      }
      if (model["type"] === "sap.ui.model.resource.ResourceModel") {
        const bundleName = (model["settings"] as Record<string, unknown>)?.["bundleName"];
        if (typeof bundleName === "string") {
          const rel = bundleName.replace(/\./g, "/");
          const segments = rel.split("/");
          // candidates: full namespace path and the suffix path (webapp root maps to the app namespace)
          const candidates = [
            path.join(webappDir, ...segments.map((seg) => `${seg}.properties`)),
            path.join(webappDir, ...segments.slice(-3).map((seg) => `${seg}.properties`)),
            path.join(webappDir, "i18n", `${segments[segments.length - 1]}.properties`)
          ];
          if (!candidates.some((c) => exists(c))) {
            issues.push({ severity: "error", rule: "models.i18n.bundle", message: `i18n bundle '${bundleName}' not found on disk (tried ${candidates.map((c) => relativePath(c, root)).join(", ")})`, path: `sap.ui5/models/${name}` });
          }
        }
      }
    }

    // routing
    const routing = sapUi5["routing"] as Record<string, unknown> | undefined;
    if (routing && typeof routing === "object") {
      const routes = (routing["routes"] ?? []) as Record<string, unknown>[];
      const targets = (routing["targets"] ?? {}) as Record<string, Record<string, unknown>>;
      const targetNames = new Set(Object.keys(targets));
      for (const route of routes) {
        const target = String(route["target"] ?? "");
        const targetsArr = Array.isArray(route["target"]) ? (route["target"] as string[]) : [target];
        for (const t of targetsArr) {
          if (t && !targetNames.has(t)) {
            issues.push({ severity: "error", rule: "routing.target.missing", message: `Route '${route["name"]}' references target '${t}' which is not defined in targets`, path: "sap.ui5/routing" });
          }
        }
        if (!route["name"]) issues.push({ severity: "error", rule: "routing.route.name", message: `Route without name: ${JSON.stringify(route)}`, path: "sap.ui5/routing/routes" });
        if (route["pattern"] === undefined) issues.push({ severity: "warning", rule: "routing.route.pattern", message: `Route '${route["name"]}' has no pattern`, path: "sap.ui5/routing/routes" });
      }
      for (const [name, t] of Object.entries(targets)) {
        const tname = String(t["viewName"] ?? t["name"] ?? "");
        if (t["type"] === "Component") continue; // FE template targets
        if (!tname) {
          issues.push({ severity: "error", rule: "routing.target.viewName", message: `Target '${name}' has no viewName`, path: `sap.ui5/routing/targets/${name}` });
        } else if (!tname.includes(".") || tname.startsWith("sap.fe") || tname.startsWith("sap.suite")) {
          // relative view name → resolve against viewPath
          const config = (routing["config"] ?? {}) as Record<string, unknown>;
          const viewPath = String(config["viewPath"] ?? "");
          const full = viewPath ? `${viewPath}.${tname}` : tname;
          checkViewExists(webappDir, appId, full, issues, `sap.ui5/routing/targets/${name}`);
        } else {
          checkViewExists(webappDir, appId, tname, issues, `sap.ui5/routing/targets/${name}`);
        }
      }
    }
  }

  // card specifics
  if (sapApp?.["type"] === "card") {
    const sapCard = (manifest["sap.card"] ?? null) as Record<string, unknown> | null;
    if (!sapCard) issues.push({ severity: "error", rule: "sap.card.required", message: "Card manifest requires a sap.card section" });
    else {
      const validCardTypes = ["Adaptive", "Analytical", "Calendar", "Component", "List", "Object", "Table", "Timeline"];
      const cardType = String(sapCard["type"] ?? "");
      if (!validCardTypes.includes(cardType)) issues.push({ severity: "error", rule: "sap.card.type", message: `sap.card/type '${cardType}' invalid. Expected: ${validCardTypes.join(", ")}` });
      if (!sapCard["header"]) issues.push({ severity: "warning", rule: "sap.card.header", message: "sap.card/header recommended" });
    }
  }

  const errors = issues.filter((i) => i.severity === "error").length;
  return { valid: errors === 0, errors, warnings: issues.length - errors, issues, manifestPath };
}

/** Views shipped by the framework: they have no file inside the app. */
const FRAMEWORK_VIEW_PREFIXES = ["sap.fe.", "sap.suite.", "sap.ovp.", "sap.ui.generic."];

/**
 * Check that a manifest view name resolves to a file.
 *
 * UI5 resolves module names against the app id, which maps to webapp/: in an app with id
 * `ns.demo`, the view `ns.demo.view.App` lives at `webapp/view/App.view.xml`. Keeping the app
 * id in the path made this rule report a missing file for every correctly built app.
 */
function checkViewExists(webappDir: string, appId: string, viewName: string, issues: ValidationIssue[], rulePath: string): void {
  const insideApp = appId && (viewName === appId || viewName.startsWith(`${appId}.`));
  if (!insideApp && FRAMEWORK_VIEW_PREFIXES.some((p) => viewName.startsWith(p))) return; // framework-provided view
  const moduleName = insideApp ? viewName.slice(appId.length).replace(/^\./, "") : viewName;
  const rel = moduleName.replace(/\./g, "/");
  const candidates = [path.join(webappDir, `${rel}.view.xml`), path.join(webappDir, "view", `${rel}.view.xml`)];
  if (candidates.some((c) => exists(c))) return;
  issues.push({
    severity: "error",
    rule: "view.file.missing",
    message: `View '${viewName}' not found on disk (expected webapp/${rel}.view.xml or webapp/view/${rel}.view.xml)`,
    path: rulePath
  });
}
