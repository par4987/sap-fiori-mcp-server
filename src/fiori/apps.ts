import fs from "node:fs";
import path from "node:path";
import { resolvePath, isDir, walkFiles, tryReadJson, exists, relativePath } from "../util/fs.js";

export interface FioriAppSummary {
  path: string;
  appId: string;
  title: string;
  type: "fiori-elements-v4" | "fiori-elements-v2" | "freestyle" | "card" | "adaptation";
  entitySet?: string;
  odataVersion?: string;
  dataSourceUri?: string;
  minUI5Version?: string;
  views: string[];
  hasFcl: boolean;
}

export interface FioriProject {
  path: string;
  name: string;
  apps: FioriAppSummary[];
  isCap: boolean;
  hasPackageJson: boolean;
  cdsFolders: { db: boolean; srv: boolean; app: boolean };
}

/** Heuristic check whether a directory is a CAP project. */
export function isCapProject(projectPath: string): boolean {
  const root = resolvePath(projectPath);
  const pkg = tryReadJson<Record<string, unknown>>(path.join(root, "package.json"));
  const deps = (pkg?.["dependencies"] ?? {}) as Record<string, unknown>;
  const devDeps = (pkg?.["devDependencies"] ?? {}) as Record<string, unknown>;
  const hasCdsDep = !!deps["@sap/cds"] || !!devDeps["@sap/cds"];
  const hasCdsFolders = exists(path.join(root, "db")) && exists(path.join(root, "srv"));
  return hasCdsDep || hasCdsFolders;
}

/** Classify one app directory (must contain webapp/manifest.json or manifest.json). */
export function readAppManifest(appDir: string): { manifest: Record<string, unknown>; manifestPath: string; webappDir: string } | null {
  for (const webappDir of [path.join(appDir, "webapp"), appDir]) {
    const manifestPath = path.join(webappDir, "manifest.json");
    if (exists(manifestPath)) {
      const manifest = tryReadJson<Record<string, unknown>>(manifestPath);
      if (manifest) return { manifest, manifestPath, webappDir };
    }
  }
  return null;
}

export function summarizeApp(appDir: string, relPath: string): FioriAppSummary | null {
  const found = readAppManifest(appDir);
  if (!found) return null;
  const { manifest, manifestPath, webappDir } = found;

  const sapApp = (manifest["sap.app"] ?? {}) as Record<string, unknown>;
  const sapUi = (manifest["sap.ui"] ?? {}) as Record<string, unknown>;
  const sapUi5 = (manifest["sap.ui5"] ?? {}) as Record<string, unknown>;
  const dataSources = (sapApp["dataSources"] ?? {}) as Record<string, Record<string, unknown>>;
  const models = (sapUi5["models"] ?? {}) as Record<string, Record<string, unknown>>;
  const rootView = sapUi5["rootView"] as Record<string, unknown> | undefined;
  const targets = ((sapUi5["routing"] as Record<string, unknown>)?.["targets"] ?? {}) as Record<string, Record<string, unknown>>;

  const mainDsKey = (Object.keys(models).find((k) => k === "" && models[k]["dataSource"]) ?? Object.keys(models).find((k) => models[k]["dataSource"])) ?? "";
  const dsName = models[mainDsKey]?.["dataSource"] as string | undefined;
  const mainDs = dsName ? dataSources[dsName] : undefined;

  let type: FioriAppSummary["type"] = "freestyle";
  const usesFeV4 = Object.values(targets).some((t) => String(t["name"] ?? "").startsWith("sap.fe.templates"));
  const usesFeV2 = String(rootView?.["viewName"] ?? "").startsWith("sap.suite.ui.generic.template") || Object.values(targets).some((t) => String(t["name"] ?? "").startsWith("sap.suite.ui.generic.template"));
  if (sapApp["type"] === "card") type = "card";
  else if (String(sapApp["id"] ?? "").includes(".variant") || exists(path.join(appDir, "manifest.appdescr_variant"))) type = "adaptation";
  else if (usesFeV4) type = "fiori-elements-v4";
  else if (usesFeV2) type = "fiori-elements-v2";

  const views = walkFiles(webappDir, (f) => f.endsWith(".view.xml") || f.endsWith(".fragment.xml"), 6)
    .map((f) => relativePath(f, webappDir))
    .slice(0, 40);

  const entitySet = (() => {
    for (const t of Object.values(targets)) {
      const settings = (t["options"] as Record<string, Record<string, unknown>> | undefined)?.["settings"];
      const es = settings?.["entitySet"];
      if (typeof es === "string") return es;
    }
    return undefined;
  })();

  const routing = sapUi5["routing"] as Record<string, unknown> | undefined;
  const routerClass = String(routing?.["config"] ? (routing["config"] as Record<string, unknown>)["routerClass"] ?? "" : "");

  return {
    path: relPath,
    appId: String(sapApp["id"] ?? ""),
    title: String(sapApp["title"] ?? sapApp["description"] ?? ""),
    type,
    entitySet,
    odataVersion: String(mainDs?.["settings"] ? ((mainDs["settings"] as Record<string, unknown>)["odataVersion"] ?? "") : ""),
    dataSourceUri: String(mainDs?.["uri"] ?? ""),
    minUI5Version: String((sapUi5["dependencies"] as Record<string, unknown>)?.["minUI5Version"] ?? (sapUi["dependencies"] as Record<string, unknown>)?.["minUI5Version"] ?? ""),
    views,
    hasFcl: routerClass.includes("sap.f.routing")
  };
}

/** Scan a workspace for Fiori applications. */
export function listFioriApps(workspacePath: string, maxDepth = 6): FioriProject {
  const root = resolvePath(workspacePath);
  if (!isDir(root)) throw new Error(`Workspace path does not exist: ${root}`);

  const apps: FioriAppSummary[] = [];
  const seen = new Set<string>();

  const visit = (dir: string, depth: number): void => {
    if (depth > maxDepth) return;
    // does this dir contain an app (manifest.json in webapp/ or directly)?
    const hasManifest = exists(path.join(dir, "webapp", "manifest.json")) || (dir !== root && exists(path.join(dir, "manifest.json")));
    if (hasManifest && !seen.has(dir)) {
      seen.add(dir);
      const summary = summarizeApp(dir, relativePath(dir, root) || ".");
      if (summary) apps.push(summary);
      return; // don't scan deeper into an app
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (["node_modules", ".git", "dist", ".ui5", "target", "gen"].includes(entry.name)) continue;
      visit(path.join(dir, entry.name), depth + 1);
    }
  };
  visit(root, 0);

  return {
    path: root,
    name: path.basename(root),
    apps,
    isCap: isCapProject(root),
    hasPackageJson: exists(path.join(root, "package.json")),
    cdsFolders: {
      db: exists(path.join(root, "db")),
      srv: exists(path.join(root, "srv")),
      app: exists(path.join(root, "app"))
    }
  };
}
