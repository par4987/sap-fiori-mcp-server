import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Expand ~ and resolve to absolute. Throws if path is empty. */
export function resolvePath(p: string, base = process.cwd()): string {
  if (!p || !p.trim()) throw new Error("A non-empty path is required");
  const expanded = p === "~" ? os.homedir() : p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
  return path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(base, expanded);
}

export function exists(p: string): boolean {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
}

export function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Drop a UTF-8 byte order mark.
 *
 * `JSON.parse` rejects a leading BOM, and it is the normal outcome on Windows: PowerShell 5.1
 * writes one with `Set-Content -Encoding utf8`, as does Notepad. Config files hand-written on
 * Windows would otherwise look corrupt for no visible reason.
 */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function readJson<T = unknown>(file: string): T {
  return JSON.parse(stripBom(fs.readFileSync(file, "utf8"))) as T;
}

export function tryReadJson<T = unknown>(file: string): T | null {
  try {
    return readJson<T>(file);
  } catch {
    return null;
  }
}

export function readText(file: string): string {
  return fs.readFileSync(file, "utf8");
}

export function tryReadText(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export function writeFileSafe(file: string, content: string): void {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, content, "utf8");
}

/** Recursively list files under dir (bounded depth) matching a filter. */
export function walkFiles(dir: string, filter: (f: string) => boolean, maxDepth = 8, _depth = 0, _acc: string[] = []): string[] {
  if (_depth > maxDepth || !isDir(dir)) return _acc;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return _acc;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist" || entry.name === ".ui5") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(full, filter, maxDepth, _depth + 1, _acc);
    } else if (filter(full)) {
      _acc.push(full);
    }
  }
  return _acc;
}

/**
 * Paths relative to `base`, always with forward slashes.
 *
 * Tool output is consumed by models and by clients on other platforms, so the separator has to
 * be stable; Windows backslashes would make the same call look different from machine to machine.
 */
export function relativePaths(files: string[], base: string): string[] {
  const root = resolvePath(base);
  return files.map((f) => path.relative(root, f).split(path.sep).join("/"));
}

/** Single path relative to `base`, always with forward slashes. */
export function relativePath(file: string, base: string): string {
  return path.relative(resolvePath(base), file).split(path.sep).join("/");
}

export function isBareError(e: unknown): e is Error {
  return e instanceof Error;
}
