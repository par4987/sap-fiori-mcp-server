import fs from "node:fs";
import path from "node:path";
import { walkFiles, readText, resolvePath, relativePath } from "../util/fs.js";
import { fuzzyNameScore } from "../util/search.js";
import { parseCdsSources, type CdsDefinition, type CdsModel } from "./cds-parser.js";

/** Locate .cds files inside a CAP project (db/, srv/, app/ plus root level). */
export function findCdsFiles(projectPath: string, maxFiles = 200): string[] {
  const root = resolvePath(projectPath);
  const all = walkFiles(
    root,
    (f) => f.endsWith(".cds"),
    8
  );
  // prioritize db/srv/app folders then root
  const prio = all.filter((f) => /[/\\](db|srv|app)[/\\]/.test(f));
  const rest = all.filter((f) => !prio.includes(f));
  return [...prio, ...rest].slice(0, maxFiles);
}

/** Build the unified CDS model for a project. */
export function buildCdsModel(projectPath: string): CdsModel {
  const files = findCdsFiles(projectPath);
  const parsed = files.map((f) => {
    let content = "";
    try {
      content = readText(f);
    } catch {
      content = "";
    }
    return { path: relativePath(f, projectPath), content };
  });
  return parseCdsSources(parsed);
}

export interface ModelSearchResult {
  name: string;
  shortName: string;
  kind: string;
  score: number;
  source: string;
  line: number;
  projectionOn?: string;
  includes?: string[];
  elementCount: number;
  actionCount: number;
  annotations: string[];
}

const KIND_FILTER: Record<string, CdsDefinition["kind"][]> = {
  entity: ["entity"],
  view: ["view"],
  service: ["service"],
  type: ["type"],
  aspect: ["aspect"],
  event: ["event"],
  action: ["action"],
  function: ["function"],
  extend: ["extend"],
  all: ["entity", "view", "service", "type", "aspect", "event", "action", "function", "extend"]
};

export function searchModel(model: CdsModel, query: string, options?: { kind?: string; limit?: number }): ModelSearchResult[] {
  const kind = options?.kind && KIND_FILTER[options.kind] ? options.kind : "all";
  const allowed = KIND_FILTER[kind];
  // no hard ceiling: callers that paginate need the full ranked list
  const limit = Math.max(1, options?.limit ?? 20);
  const results: ModelSearchResult[] = [];
  for (const def of model.definitions) {
    if (!allowed.includes(def.kind)) continue;
    // score against name and element names
    let score = fuzzyNameScore(query, def.name);
    if (score === 0) {
      const elScore = Math.max(0, ...def.elements.map((e) => fuzzyNameScore(query, e.name) * 0.5));
      score = elScore;
    }
    if (score <= 0) continue;
    results.push({
      name: def.name,
      shortName: def.shortName,
      kind: def.kind,
      score,
      source: def.source,
      line: def.line,
      projectionOn: def.projectionOn,
      includes: def.includes,
      elementCount: def.elements.length,
      actionCount: def.actions.length,
      annotations: Object.keys(def.annotations)
    });
  }
  results.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return results.slice(0, limit);
}

/** Full details for one definition, including elements, associations and annotations. */
export function getDefinitionDetails(model: CdsModel, name: string): Record<string, unknown> | null {
  const def =
    model.definitions.find((d) => d.name.toLowerCase() === name.toLowerCase()) ??
    model.definitions.find((d) => d.shortName.toLowerCase() === name.toLowerCase());
  if (!def) return null;

  return {
    name: def.name,
    // callers match exposures on the short name; leaving it out silently broke that lookup
    shortName: def.shortName,
    kind: def.kind,
    source: def.source,
    line: def.line,
    namespace: def.namespace,
    projectionOn: def.projectionOn,
    selectFrom: def.selectFrom,
    includes: def.includes,
    annotations: def.annotations,
    elements: def.elements.map((e) => ({
      name: e.name,
      type: e.type,
      kind: e.kind,
      target: e.target,
      cardinality: e.cardinality,
      on: e.on,
      notNull: e.notNull ?? false,
      default: e.default,
      array: e.array ?? false,
      annotations: e.annotations
    })),
    actions: def.actions
  };
}

/** Extract the entitySet projection graph inside services: service entity -> source entity. */
export function getServiceExposure(model: CdsModel): { service: string; exposed: { name: string; source: string; kind: string }[] }[] {
  const services = model.definitions.filter((d) => d.kind === "service");
  return services.map((svc) => {
    const prefix = `${svc.name}.`;
    const exposed = model.definitions
      .filter((d) => d.name.startsWith(prefix) && (d.kind === "view" || d.kind === "entity"))
      .map((d) => ({
        name: d.shortName,
        source: d.projectionOn ?? d.selectFrom ?? "",
        kind: d.projectionOn ? "projection" : d.selectFrom ? "select" : "entity"
      }));
    return { service: svc.name, exposed };
  });
}

/** Resolve CSV data files following CAP convention: <data dir>/<namespace>-<Entity>.csv */
export function resolveEntityCsv(projectPath: string, entityName: string): string | null {
  const root = resolvePath(projectPath);
  const candidates: string[] = [];
  const walk = (dir: string, depth = 0): void => {
    if (depth > 6) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name === ".git") continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (e.name.toLowerCase().endsWith(".csv")) candidates.push(full);
    }
  };
  walk(root);
  const short = entityName.split(".").pop()!.toLowerCase();
  const match = candidates.find((f) => {
    const base = path.basename(f).toLowerCase().replace(/\.csv$/, "");
    return base === short || base.endsWith(`-${short}`);
  });
  return match ?? null;
}
