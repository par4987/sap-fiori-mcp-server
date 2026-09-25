/**
 * Produces the folder that gets archived for ABAP: `dist/` after a real `ui5 build`, or the raw
 * `webapp/` when the tooling is not there.
 *
 * The generator writes no build output and installs nothing, so "build" here also means "make the
 * build possible": `npm install` runs only when `node_modules` is absent, and a failure to build is
 * never fatal — the source folder is shipped instead, with the reason attached to the result.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface BuildOptions {
  /** Ship `webapp/` without trying to build. */
  skipBuild?: boolean;
  /** Allow `npm install` when node_modules is missing. Tests pass false. */
  install?: boolean;
  timeoutMs?: number;
  installTimeoutMs?: number;
}

export interface BuildOutcome {
  /** "dist" when the project was compiled, "source" when the untouched webapp folder goes out. */
  mode: "dist" | "source";
  /** Absolute folder whose contents become the root of the archive. */
  dir: string;
  built: boolean;
  durationMs: number;
  /** Why the build did not happen, or anything it did not like. */
  warnings: string[];
  /** Tail of the tooling output, kept for the response. */
  log: string;
}

const LOG_LIMIT = 8000;

/** The folder holding `ui5.yaml` + `webapp/`: the app path, or its parent when webapp was passed. */
export function projectRootOf(appPath: string): string {
  const root = path.basename(appPath.replace(/[\\/]+$/, "")) === "webapp" ? path.dirname(appPath) : appPath;
  if (!fs.existsSync(path.join(root, "webapp", "manifest.json"))) {
    throw new Error(`No webapp/manifest.json under ${root}. Point appPath at the generated app folder.`);
  }
  return root;
}

/**
 * Absolute path of the UI5 CLI inside the project, or null when it is not installed.
 *
 * Read from `@ui5/cli`'s own package.json rather than the `.bin` shim: the shim is a `.cmd` on
 * Windows, and spawning it needs a shell we would then have to quote user paths into.
 */
export function resolveUi5Cli(projectRoot: string): string | null {
  const pkgPath = path.join(projectRoot, "node_modules", "@ui5", "cli", "package.json");
  if (!fs.existsSync(pkgPath)) return null;
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { bin?: string | Record<string, string> };
    const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.ui5 ?? Object.values(pkg.bin ?? {})[0];
    if (!bin) return null;
    const resolved = path.resolve(path.dirname(pkgPath), bin);
    return fs.existsSync(resolved) ? resolved : null;
  } catch {
    return null;
  }
}

/** npm's own cli, resolved next to the running node, so no `.cmd` shim is involved. */
function npmCli(): string | null {
  const candidate = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  return fs.existsSync(candidate) ? candidate : null;
}

function run(cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<{ code: number; out: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const collect = (chunk: Buffer | string) => {
      if (out.length < LOG_LIMIT * 2) out += String(chunk);
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    const timer = setTimeout(() => {
      out += `\n[timeout after ${Math.round(timeoutMs / 1000)}s]`;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`${cmd} could not be started: ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, out: out.slice(-LOG_LIMIT) });
    });
  });
}

function dirHasFiles(dir: string): boolean {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    return entries.some((e) => (e.isDirectory() ? dirHasFiles(path.join(dir, e.name)) : true));
  } catch {
    return false;
  }
}

/**
 * Build (or prepare) the application for deployment.
 *
 * Order: skip → install if needed → `ui5 build` → fall back to the source folder. Whatever happens,
 * the caller gets a folder to archive and a list of reasons if it is not the compiled one.
 */
export async function buildApp(appPath: string, opts: BuildOptions = {}): Promise<BuildOutcome> {
  const started = Date.now();
  const root = projectRootOf(appPath);
  const webapp = path.join(root, "webapp");
  const warnings: string[] = [];
  const source: BuildOutcome = {
    mode: "source",
    dir: webapp,
    built: false,
    durationMs: 0,
    warnings,
    log: ""
  };

  if (opts.skipBuild) {
    warnings.push("skipBuild=true: deploying webapp/ without compiling.");
    source.durationMs = Date.now() - started;
    return source;
  }

  let cli = resolveUi5Cli(root);
  if (!cli && opts.install !== false) {
    const npm = npmCli();
    if (!npm) {
      warnings.push("npm was not found next to the running node: cannot install @ui5/cli, deploying webapp/.");
    } else if (!fs.existsSync(path.join(root, "node_modules"))) {
      warnings.push("node_modules is missing in the app: running npm install so ui5 build can run.");
      try {
        const res = await run(
          process.execPath,
          [npm, "install", "--no-audit", "--no-fund", "--loglevel=error"],
          root,
          opts.installTimeoutMs ?? 300000
        );
        if (res.code !== 0) warnings.push(`npm install failed (exit ${res.code}): ${res.out.slice(-1200)}`);
      } catch (e) {
        warnings.push(`npm install could not run: ${e instanceof Error ? e.message : String(e)}`);
      }
      cli = resolveUi5Cli(root);
    }
  }

  if (!cli) {
    warnings.push(
      "@ui5/cli is not installed in the app (run `npm install` there): deploying webapp/ without a component-preload."
    );
    source.durationMs = Date.now() - started;
    return source;
  }

  const dest = path.join(root, "dist");
  try {
    const res = await run(process.execPath, [cli, "build", "--dest", "dist"], root, opts.timeoutMs ?? 300000);
    if (res.code !== 0 || !dirHasFiles(dest)) {
      warnings.push(`ui5 build did not produce dist/ (exit ${res.code}): deploying webapp/ instead. Tail: ${res.out.slice(-1200)}`);
      source.log = res.out;
      source.durationMs = Date.now() - started;
      return source;
    }
    return {
      mode: "dist",
      dir: dest,
      built: true,
      durationMs: Date.now() - started,
      warnings,
      log: res.out
    };
  } catch (e) {
    warnings.push(`ui5 build could not run (${e instanceof Error ? e.message : String(e)}): deploying webapp/ instead.`);
    source.durationMs = Date.now() - started;
    return source;
  }
}
