/**
 * Builds the zip ABAP stores as the application archive.
 *
 * The archive root must be the application root itself (`manifest.json` at the top, not inside a
 * `webapp/` folder), because `/sap/bc/ui5_ui5/sap/<bsp>/manifest.json` is what the runtime asks for.
 * Overrides exist so `index.html` can carry a rewritten bootstrap without touching the build output.
 */
import fs from "node:fs";
import path from "node:path";
import { ZipFile } from "yazl";

/** Never part of an application archive, wherever they appear. */
const IGNORED_DIRS = new Set(["node_modules", ".git", ".pnpm", ".yarn"]);
const IGNORED_FILES = new Set([".DS_Store", "Thumbs.db"]);

export interface ZipOverride {
  /** Path inside the archive, always with forward slashes. */
  path: string;
  content: Buffer | string;
}

export interface ZipResult {
  buffer: Buffer;
  /** Archive paths, in archive order. */
  files: string[];
}

function walk(dir: string, base: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORED_DIRS.has(entry.name) || IGNORED_FILES.has(entry.name)) continue;
    const abs = path.join(dir, entry.name);
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) walk(abs, rel, out);
    else if (entry.isFile()) out.push(rel);
  }
}

/** Zip a folder's contents (recursively), replacing or adding the given paths. */
export async function zipFolder(dir: string, overrides: ZipOverride[] = []): Promise<ZipResult> {
  const abs = path.resolve(dir);
  if (!fs.existsSync(abs)) throw new Error(`Nothing to archive: ${abs} does not exist.`);
  const rels: string[] = [];
  walk(abs, "", rels);

  const overrideByPath = new Map(overrides.map((o) => [o.path.replace(/\\/g, "/"), o]));
  const paths = [...new Set([...rels, ...overrideByPath.keys()])].sort();

  const zip = new ZipFile();
  const chunks: Buffer[] = [];
  const done = new Promise<void>((resolve, reject) => {
    zip.outputStream.on("data", (c: Buffer) => chunks.push(c));
    zip.outputStream.on("end", () => resolve());
    zip.outputStream.on("error", reject);
    zip.on("error", reject);
  });

  for (const rel of paths) {
    const override = overrideByPath.get(rel);
    if (override) zip.addBuffer(Buffer.isBuffer(override.content) ? override.content : Buffer.from(override.content, "utf8"), rel);
    else zip.addFile(path.join(abs, rel.replace(/\//g, path.sep)), rel);
  }

  zip.end();
  await done;
  return { buffer: Buffer.concat(chunks), files: paths };
}
