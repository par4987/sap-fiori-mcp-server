import path from "node:path";
import type { AppConfig } from "../config.js";
import { tryReadJson, tryReadText, resolvePath, exists } from "../util/fs.js";
import { assertUrlAllowed } from "../net/guard.js";

export const CDN_URLS: Record<"openui5" | "sapui5", string> = {
  openui5: "https://sdk.openui5.org",
  sapui5: "https://ui5.sap.com"
};

export interface VersionInfo {
  distribution: "openui5" | "sapui5";
  latest: string | null;
  libraries?: { name: string; version: string }[];
  localProjectVersion?: string | null;
  source: string;
  note?: string;
}

/** Fetch version info from the UI5 CDN and optionally read the local project's version. */
export async function getVersionInfo(config: AppConfig, projectPath?: string): Promise<VersionInfo> {
  const cdn = config.ui5CdnUrl || CDN_URLS[config.ui5Distribution];
  let latest: string | null = null;
  let libraries: { name: string; version: string }[] | undefined;
  const source = `${cdn}/resources/sap-ui-version.json`;
  let fetchError: string | undefined;

  try {
    assertUrlAllowed(config, source, [cdn]);
    const res = await fetch(source, { signal: AbortSignal.timeout(config.requestTimeoutMs) });
    if (res.ok) {
      const data = (await res.json()) as { version?: string; libraries?: { name: string; version: string }[] };
      latest = data.version ?? null;
      libraries = data.libraries?.slice(0, 30);
    }
  } catch (e) {
    fetchError = e instanceof Error ? e.message : String(e);
  }

  let localProjectVersion: string | null | undefined;
  if (projectPath) {
    localProjectVersion = readLocalUi5Version(resolvePath(projectPath));
  }

  return {
    distribution: config.ui5Distribution,
    latest,
    libraries,
    localProjectVersion: localProjectVersion ?? undefined,
    source,
    note: latest ? undefined : `Could not read ${source}${fetchError ? `: ${fetchError}` : " (offline?)"}. Falling back to the local project version only.`
  };
}

/** Best-effort detection of the UI5 version used by a local project. */
export function readLocalUi5Version(projectPath: string): string | null {
  // manifest minUI5Version
  for (const candidate of [path.join(projectPath, "webapp", "manifest.json"), path.join(projectPath, "manifest.json")]) {
    const manifest = tryReadJson<Record<string, unknown>>(candidate);
    if (manifest) {
      const ui5 = manifest["sap.ui5"] as Record<string, unknown> | undefined;
      const deps = ui5?.["dependencies"] as Record<string, unknown> | undefined;
      const min = deps?.["minUI5Version"];
      if (typeof min === "string") return min;
    }
  }
  // ui5.yaml framework version
  for (const candidate of [path.join(projectPath, "ui5.yaml"), path.join(projectPath, "webapp", "ui5.yaml")]) {
    const yaml = tryReadText(candidate);
    if (yaml) {
      const m = /^\s*version:\s*["']?([\d.]+)["']?\s*$/m.exec(yaml);
      if (m) return m[1];
    }
  }
  // package.json sapui5 deps
  const pkg = tryReadJson<Record<string, unknown>>(path.join(projectPath, "package.json"));
  if (pkg) {
    const all = { ...((pkg["dependencies"] ?? {}) as Record<string, string>), ...((pkg["devDependencies"] ?? {}) as Record<string, string>) };
    const ui5dep = Object.entries(all).find(([k]) => k.startsWith("@sapui5/") || k.startsWith("@openui5/"));
    if (ui5dep) {
      const v = ui5dep[1].replace(/[^0-9.]/g, "");
      if (v) return v;
    }
  }
  return null;
}

/** Which UI5 CDN base URL an app should use (also used by project info). */
export function resolveCdnForProject(config: AppConfig, projectPath: string): string {
  const appIndex = ["webapp/index.html", "index.html"].map((p) => path.join(resolvePath(projectPath), p));
  for (const f of appIndex) {
    if (exists(f)) {
      const html = tryReadText(f) ?? "";
      if (html.includes("ui5.sap.com")) return CDN_URLS.sapui5;
      if (html.includes("sdk.openui5.org")) return CDN_URLS.openui5;
    }
  }
  return config.ui5CdnUrl || CDN_URLS[config.ui5Distribution];
}
