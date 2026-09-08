import fs from "node:fs";
import path from "node:path";
import { resolvePath, walkFiles, readText, relativePath } from "../util/fs.js";
import { logger } from "../logger.js";

export interface LintIssue {
  severity: "error" | "warning" | "info";
  file: string;
  line?: number;
  rule: string;
  message: string;
}

const DEPRECATED_GLOBALS: { pattern: RegExp; rule: string; message: string }[] = [
  { pattern: /jQuery\.sap\.(?:require|includeScript|registerModulePath|getResourcePath|getUriParameters|denormalizeScrollLeftRTL|normalizeScrollLeftRTL)\s*\(/g, rule: "api.deprecated.jQuerySap", message: "jQuery.sap.* utility is deprecated: use sap.ui.define AMD dependencies instead" },
  { pattern: /jQuery\.sap\.log(?:ger)?\s*\.\s*\w+/g, rule: "api.deprecated.jQuerySapLog", message: "jQuery.sap.log is deprecated: use module 'sap/base/Log'" },
  { pattern: /sap\.ui\.getCore\(\)\s*\.\s*byId\s*\(/g, rule: "api.deprecated.coreById", message: "sap.ui.getCore().byId() is not allowed in controllers: use this.byId() (views) or Fragment.byId" },
  { pattern: /sap\.ui\.require\.sync\s*\(/g, rule: "api.deprecated.requireSync", message: "sap.ui.require.sync is deprecated: use async sap.ui.require or loadFragment" },
  { pattern: /sap\.ui\.(?:commons|ux3)/g, rule: "api.removed.library", message: "Library sap.ui.commons / sap.ui.ux3 is removed: migrate to sap.m / sap.ui.layout" },
  { pattern: /\bsap\.m\.StandardTile\b/g, rule: "api.deprecated.StandardTile", message: "sap.m.StandardTile is deprecated: use sap.m.Tile with TileContent/ImageContent" },
  { pattern: /\bsap\.m\.MessageBox\.show\b\s*\(/g, rule: "api.info.MessageBox", message: "Prefer typed helpers MessageBox.alert/confirm/warning/error/success" },
  { pattern: /new\s+sap\.ui\.model\.odata\.v2\.ODataModel\s*\(/g, rule: "api.info.v2Model", message: "OData V2 model usage detected: for new development prefer OData V4 (sap/ui/model/odata/v4/ODataModel)" }
];

const DEPRECATED_XML_CONTROLS = new Set([
  "sap.m.StandardTile",
  "sap.ui.commons.Button",
  "sap.ui.commons.TextField",
  "sap.ui.commons.Panel",
  "sap.ui.ux3.Shell",
  "sap.m.OverflowToolbarButton", // restricted contexts; keep as warning
  "sap.m.ScrollBar"
]);

const XML_STD_NS = "http://www.w3.org/ns/xhtml";

/** Run UI5-specific lint checks over webapp JS/XML files. */
export function runUi5Linter(projectPath: string, options?: { files?: string[] }): { issues: LintIssue[]; filesScanned: number } {
  const root = resolvePath(projectPath);
  const webappCandidates = [path.join(root, "webapp"), root];
  const webappDir = webappCandidates.find((p) => fs.existsSync(p)) ?? root;

  const jsFilter = (f: string) => /\.(js|ts)$/.test(f) && !/\.d\.ts$/.test(f) && !/node_modules/.test(f);
  const xmlFilter = (f: string) => /\.view\.xml$|\.fragment\.xml$/.test(f) && !/node_modules/.test(f);

  const jsFiles = options?.files?.length ? options.files.filter(jsFilter) : walkFiles(webappDir, jsFilter, 8);
  const xmlFiles = options?.files?.length ? options.files.filter(xmlFilter) : walkFiles(webappDir, xmlFilter, 8);

  const issues: LintIssue[] = [];

  for (const file of jsFiles) {
    let content: string;
    try {
      content = readText(file);
    } catch {
      continue;
    }
    for (const dep of DEPRECATED_GLOBALS) {
      dep.pattern.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = dep.pattern.exec(content)) !== null) {
        issues.push({
          severity: dep.rule.includes(".info.") ? "info" : /removed|coreById|requireSync/.test(dep.rule) ? "error" : "warning",
          file: relativePath(file, root),
          line: lineOf(content, m.index),
          rule: dep.rule,
          message: dep.message
        });
      }
    }
    // event handlers on controllers referencing undefined methods is too complex; check sap.ui.define format
    if (!/sap\.ui\.define|import\s+.*from\s+["']/.test(content) && content.trim().length > 0 && /sap\.|onInit|extend\(/.test(content)) {
      issues.push({ severity: "warning", file: relativePath(file, root), rule: "module.define.missing", message: "File seems to use UI5 APIs without sap.ui.define (AMD) or ESM import — globals are not allowed" });
    }
  }

  for (const file of xmlFiles) {
    let content: string;
    try {
      content = readText(file);
    } catch {
      continue;
    }
    // deprecated controls
    for (const control of DEPRECATED_XML_CONTROLS) {
      const prefix = control.split(".").slice(0, -1).join(".");
      const tag = control.split(".").pop()!;
      const re = new RegExp(`<(${prefix.replace(/\./g, "\\.").replace(/\./g, "\\.")})\\s*:\\s*(${tag})[\\s>/]`, "g");
      void re;
      // simpler: find xmlns declarations mapping prefixes → libraries, then check tags
    }
    // xmlns → prefix map
    const xmlnsRe = /xmlns:([\w-]+)="([^"]+)"/g;
    const prefixMap: Record<string, string> = { ...defaultPrefixes(content) };
    let mm: RegExpExecArray | null;
    while ((mm = xmlnsRe.exec(content)) !== null) prefixMap[mm[1]] = mm[2];
    for (const [prefix, lib] of Object.entries(prefixMap)) {
      for (const control of DEPRECATED_XML_CONTROLS) {
        if (lib === control.split(".").slice(0, -1).join(".")) {
          const tag = control.split(".").pop()!;
          const tagRe = new RegExp(`<${prefix}:${tag}[\\s>]`, "g");
          let m: RegExpExecArray | null;
          while ((m = tagRe.exec(content)) !== null) {
            issues.push({
              severity: control === "sap.m.OverflowToolbarButton" ? "info" : "warning",
              file: relativePath(file, root),
              line: lineOf(content, m.index),
              rule: "xml.deprecated.control",
              message: `<${prefix}:${tag}> is deprecated (${control}) — check the UI5 migration guide`
            });
          }
        }
      }
    }
    // missing controllerName is fine; but a declared controllerName must exist
    const cnMatch = /controllerName="([^"]+)"/.exec(content);
    if (cnMatch) {
      const controllerPath = cnMatch[1].replace(/\./g, "/");
      const candidates = [path.join(webappDir, `${controllerPath}.controller.js`), path.join(webappDir, `${controllerPath}.js`), path.join(webappDir, `${controllerPath}.controller.ts`)];
      if (!candidates.some((c) => fs.existsSync(c))) {
        issues.push({ severity: "error", file: relativePath(file, root), rule: "xml.controller.missing", message: `controllerName '${cnMatch[1]}' has no matching controller file` });
      }
    }
    // i18n keys existence
    const i18nDirs = [path.join(webappDir, "i18n"), webappDir];
    const bundle = i18nDirs.map((d) => path.join(d, "i18n.properties")).find((p) => fs.existsSync(p));
    if (bundle) {
      const bundleContent = readText(bundle);
      const keys = new Set(
        bundleContent
          .split("\n")
          .map((l) => /^([A-Za-z0-9_.-]+)\s*=/.exec(l)?.[1]?.trim())
          .filter((k): k is string => !!k)
      );
      const re = /\{i18n>([\w./-]+)\}/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(content)) !== null) {
        const key = m[1];
        const baseKey = key.split("/")[0];
        if (!keys.has(baseKey) && !keys.has(key)) {
          issues.push({ severity: "error", file: relativePath(file, root), line: lineOf(content, m.index), rule: "i18n.key.missing", message: `i18n key '${key}' not found in ${relativePath(bundle, root)}` });
        }
      }
    }
  }

  logger.debug("runUi5Linter done", { root, issues: issues.length });
  return { issues, filesScanned: jsFiles.length + xmlFiles.length };
}

function lineOf(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i++) if (content[i] === "\n") line++;
  return line;
}

function defaultPrefixes(content: string): Record<string, string> {
  const map: Record<string, string> = {};
  // common conventions
  if (/xmlns="sap\.m"/.test(content)) map[""] = "sap.m";
  if (/xmlns:mvc="sap\.ui\.core\.mvc"/.test(content)) map["mvc"] = "sap.ui.core.mvc";
  if (/xmlns:core="sap\.ui\.core"/.test(content)) map["core"] = "sap.ui.core";
  if (/xmlns:f="sap\.f"/.test(content)) map["f"] = "sap.f";
  if (/xmlns:macros="sap\.fe\.macros"/.test(content)) map["macros"] = "sap.fe.macros";
  return map;
}

void XML_STD_NS;
