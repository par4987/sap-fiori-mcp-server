import fs from "node:fs";
import path from "node:path";
import { resolvePath, exists, tryReadJson, walkFiles, tryReadText, relativePath } from "../util/fs.js";
import { readAppManifest, summarizeApp, isCapProject } from "../fiori/apps.js";

export interface ProjectInfo {
  path: string;
  name: string;
  kind: "ui5-app" | "cap-project" | "ui5-library" | "card" | "unknown";
  appId?: string;
  appTitle?: string;
  appType?: string;
  framework?: { name: "SAPUI5" | "OpenUI5" | "unknown"; minVersion?: string; libs?: string[] };
  manifestPath?: string;
  ui5Yaml?: string;
  views?: string[];
  controllers?: string[];
  models?: Record<string, unknown>;
  routing?: unknown;
  dataSources?: unknown;
  packageScripts?: string[];
  cdsServices?: string[];
  apps?: { path: string; id: string; type: string }[];
}

/** Extract structured metadata + configuration from a UI5/CAP project. */
export function getProjectInfo(projectPath: string): ProjectInfo {
  const root = resolvePath(projectPath);
  if (!exists(root)) throw new Error(`Path does not exist: ${root}`);
  const pkg = tryReadJson<{ name?: string; scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> }>(path.join(root, "package.json"));

  const info: ProjectInfo = { path: root, name: path.basename(root), kind: "unknown" };

  // CAP?
  if (isCapProject(root)) {
    info.kind = "cap-project";
    info.cdsServices = [];
    const srvFiles = walkFiles(root, (f) => f.endsWith(".cds") && /[/\\]srv[/\\]/.test(f), 4);
    for (const f of srvFiles) {
      const content = tryReadText(f) ?? "";
      const m = /\bservice\s+([\w.$]+)/g;
      let mm: RegExpExecArray | null;
      while ((mm = m.exec(content)) !== null) info.cdsServices!.push(`${relativePath(f, root)}: ${mm[1]}`);
    }
  }

  // Apps inside (CAP: app/ folder; standalone: root or any subfolder)
  const appDirs: string[] = [];
  const appRoot = path.join(root, "app");
  if (exists(appRoot)) {
    const { walkApps } = scanApps();
    appDirs.push(...walkApps(appRoot));
  }
  const selfManifest = exists(path.join(root, "webapp", "manifest.json"));
  if (selfManifest) appDirs.push(root);
  if (!appDirs.length) {
    const { walkApps } = scanApps();
    appDirs.push(...walkApps(root, 3).filter((d) => d !== root));
  }

  if (appDirs.length) {
    info.apps = appDirs.map((dir) => {
      const s = summarizeApp(dir, relativePath(dir, root));
      return { path: relativePath(dir, root) || ".", id: s?.appId ?? "", type: s?.type ?? "freestyle" };
    });
  }

  // single app details
  const single = selfManifest ? root : appDirs[0];
  if (single) {
    const found = readAppManifest(single);
    if (found) {
      const s = summarizeApp(single, relativePath(single, root) || ".");
      info.kind = info.kind === "cap-project" ? "cap-project" : s?.type === "card" ? "card" : s?.type?.startsWith("fiori-elements") ? "ui5-app" : "ui5-app";
      info.appId = s?.appId;
      info.appTitle = s?.title;
      info.appType = s?.type;
      info.manifestPath = found.manifestPath;
      const ui5 = (found.manifest["sap.ui5"] ?? {}) as Record<string, unknown>;
      const deps = (ui5["dependencies"] ?? {}) as Record<string, unknown>;
      info.framework = {
        name: s?.minUI5Version ? "SAPUI5" : "unknown",
        minVersion: s?.minUI5Version,
        libs: Object.keys((deps["libs"] ?? {}) as Record<string, unknown>)
      };
      info.views = s?.views;
      info.controllers = walkFiles(found.webappDir, (f) => /\.controller\.(js|ts)$/.test(f), 5).map((f) => relativePath(f, found.webappDir)).slice(0, 40);
      info.models = ui5["models"] as Record<string, unknown> | undefined;
      info.routing = ui5["routing"];
      info.dataSources = ((found.manifest["sap.app"] ?? {}) as Record<string, unknown>)["dataSources"];
    }
  }

  const ui5YamlPath = ["ui5.yaml", path.join(single ?? "", "ui5.yaml")].find((p) => exists(p));
  if (ui5YamlPath) info.ui5Yaml = path.resolve(ui5YamlPath);

  if (pkg) {
    info.packageScripts = Object.keys(pkg.scripts ?? {});
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (allDeps["@sapui5/ts-types-esm"] || allDeps["@types/openui5"]) info.framework = info.framework ?? { name: "unknown" };
    info.framework = info.framework ?? undefined;
  }

  return info;
}

function scanApps(): { walkApps: (dir: string, maxDepth?: number) => string[] } {
  const walkApps = (dir: string, maxDepth = 5): string[] => {
    const out: string[] = [];
    const visit = (d: string, depth: number): void => {
      if (depth > maxDepth) return;
      if (exists(path.join(d, "webapp", "manifest.json")) || exists(path.join(d, "manifest.json"))) {
        out.push(d);
        return;
      }
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.isDirectory() && !["node_modules", ".git"].includes(e.name)) visit(path.join(d, e.name), depth + 1);
      }
    };
    visit(dir, 0);
    return out;
  };
  return { walkApps };
}
