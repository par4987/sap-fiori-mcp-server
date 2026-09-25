/**
 * Publishes a generated Fiori application on the ABAP system it belongs to.
 *
 * Both targets this server knows — an on-premise S/4 and an ABAP Environment instance on BTP —
 * speak the same UI5 Repository service, so one flow covers both: validate the manifest, build,
 * archive, `POST`/`PUT` the repository entry, then fetch the public URL the app is served on to
 * prove it is really published. The target is the one the app was generated against: it is taken
 * from the arguments, or inferred from the service URL already written into the manifest.
 */
import path from "node:path";
import fs from "node:fs";
import fsp from "node:fs/promises";
import type { AppConfig } from "../config.js";
import { logger } from "../logger.js";
import { odataRequest, type ODataResponse } from "../odata/client.js";
import { loadDestinations, resolveODataTarget, type ODataTarget } from "../btp/destinations.js";
import { readAppManifest } from "../fiori/apps.js";
import { buildApp, projectRootOf, type BuildOutcome } from "./build.js";
import { zipFolder } from "./zip.js";
import {
  DESCRIPTION_MAX,
  LOCAL_RESOURCE_ROOTS,
  REPOSITORY_SERVICE_PATH,
  appUi5Version,
  frontendAppUrl,
  manifestServiceUris,
  repositoryPayload,
  rewriteBootstrap,
  sanitizeBspName,
  validateBspName
} from "./bsp.js";

export interface DeployParams {
  config: AppConfig;
  appPath: string;
  /** BTP destination holding the target system (overrides systemName). */
  destination?: string;
  /** System configured with list_sap_systems (overrides inference). */
  systemName?: string;
  bspName?: string;
  /** ABAP package to record the application in. `$TMP` keeps it local and transport-free. */
  abapPackage?: string;
  /** Transport request number. Required by real packages, never by `$TMP`, `L*` or `T*`. */
  transport?: string;
  description?: string;
  skipBuild?: boolean;
  bootstrap?: "cdn" | "local" | "keep";
  verify?: boolean;
  timeoutMs?: number;
  /** Test hooks: skip the npm install / build attempts. */
  install?: boolean;
  /** Ask the pinned CDN build whether it exists. Tests leave it off to stay offline. */
  bootstrapCheck?: boolean;
}

export interface DeployResult {
  ok: boolean;
  /** Where the flow stopped when ok is false. */
  stage: "resolve-target" | "validate" | "build" | "archive" | "deploy" | "verify";
  target: { source: string; kind: "system" | "destination"; name: string; url: string; inferred: boolean };
  bsp: { name: string; adjustedFrom?: string; package: string; transport?: string; description: string };
  action: "created" | "updated" | "none";
  httpStatus: number;
  appUrl: string;
  build: { mode: "dist" | "source"; built: boolean; durationMs: number; root: string };
  archive: { bytes: number; files: number };
  bootstrap: { mode: string; from?: string; to?: string; changed: boolean; checked?: boolean; checkedOk?: boolean };
  verification: { attempted: boolean; ok: boolean; status?: number; contentType?: string; note?: string };
  /** The system's own message about the upload (`sap-message`). */
  sapMessage?: string;
  warnings: string[];
  nextSteps: string[];
}

/** Origins equal after the ABAP `.abap-web.` / `.abap.` aliasing, so an app matches its system. */
function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}
function normalizedOrigin(url: string): string | null {
  const origin = originOf(url);
  return origin ? origin.replace(".abap-web.", ".abap.") : null;
}

/**
 * The target an app was generated against, read back out of the manifest's own service URL.
 * A relative URI says nothing about a host, so it is skipped.
 */
export function inferTarget(
  config: AppConfig,
  uris: string[]
): { destination?: string; systemName?: string; url: string } | null {
  for (const uri of uris) {
    const origin = normalizedOrigin(uri);
    if (!origin) continue;
    for (const system of config.sapSystems) {
      if (normalizedOrigin(system.url) === origin) return { systemName: system.name, url: system.url };
    }
    for (const d of loadDestinations(config)) {
      if (normalizedOrigin(d.url) === origin) return { destination: d.name, url: d.url };
    }
  }
  return null;
}

async function resolveDeployTarget(
  params: DeployParams,
  uris: string[]
): Promise<{ target: ODataTarget; inferred: boolean; warnings: string[] }> {
  const { config } = params;
  const timeout = params.timeoutMs ?? config.requestTimeoutMs;
  const warnings: string[] = [];

  if (params.destination) {
    const target = await resolveODataTarget(config, { destination: params.destination, servicePath: REPOSITORY_SERVICE_PATH }, timeout);
    return { target, inferred: false, warnings };
  }
  if (params.systemName) {
    const target = await resolveODataTarget(config, { systemName: params.systemName, servicePath: REPOSITORY_SERVICE_PATH }, timeout);
    return { target, inferred: false, warnings };
  }

  const inferred = inferTarget(config, uris);
  if (inferred) {
    const target = await resolveODataTarget(
      config,
      { ...(inferred.destination ? { destination: inferred.destination } : { systemName: inferred.systemName }), servicePath: REPOSITORY_SERVICE_PATH },
      timeout
    );
    warnings.push(`Target taken from the manifest service URL: ${target.source}.`);
    return { target, inferred: true, warnings };
  }

  if (config.sapSystems.length === 1 && !loadDestinations(config).length) {
    const target = await resolveODataTarget(config, { systemName: config.sapSystems[0].name, servicePath: REPOSITORY_SERVICE_PATH }, timeout);
    warnings.push(
      `The manifest does not name a reachable host, and only one system is configured: deploying to ${target.source}. ` +
        "Pass systemName or destination to choose explicitly."
    );
    return { target, inferred: true, warnings };
  }

  throw new Error(
    "Cannot tell where this app belongs. Pass systemName (list_sap_systems) or destination (list_btp_destinations): " +
      "the manifest service URL points at no configured system or destination."
  );
}

async function headOk(url: string, config: AppConfig, trustedUrls: string[], timeoutMs: number): Promise<boolean> {
  try {
    const res = await odataRequest({ url, method: "HEAD", accept: "*/*", timeoutMs, config, trustedUrls });
    return res.ok;
  } catch {
    return false;
  }
}

/** Does this ABAP system serve its own UI5 framework? Only asked for bootstrap:"local". */
async function probeLocalResources(
  baseUrl: string,
  target: ODataTarget,
  config: AppConfig,
  timeoutMs: number
): Promise<string | null> {
  const origin = originOf(baseUrl);
  if (!origin) return null;
  for (const root of LOCAL_RESOURCE_ROOTS) {
    try {
      const res = await odataRequest({
        url: `${origin}${root}/sap-ui-core.js`,
        system: target.system,
        headers: target.headers,
        method: "HEAD",
        accept: "*/*",
        timeoutMs,
        config,
        trustedUrls: target.trustedUrls
      });
      if (res.ok) return root;
    } catch {
      /* try the next known root */
    }
  }
  return null;
}

/**
 * A manifest title is often a reference (`{{appTitle}}`, `i18n>title`) rather than the text itself,
 * and shipping that reference as the BSP description would put a placeholder into the system.
 */
function i18nValue(manifest: Record<string, unknown>, webappDir: string, raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const key = /^\{\{([\w.]+)\}\}$/.exec(raw)?.[1] ?? /^(?:[a-z0-9._-]+>|>)([\w.]+)$/i.exec(raw)?.[1];
  if (!key) return /[{}<>]/.test(raw) ? null : raw.trim();
  const declared = (manifest["sap.app"] as { i18n?: unknown } | undefined)?.i18n;
  const rel = typeof declared === "string" && declared ? declared : "i18n/i18n.properties";
  try {
    const text = fs.readFileSync(path.join(webappDir, rel), "utf8");
    const line = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*[=:]\\s*(.*)$`, "m").exec(text);
    return line ? line[1].trim() || null : null;
  } catch {
    return null;
  }
}

function descriptionFor(manifest: Record<string, unknown>, webappDir: string, fallback: string): string {
  const title = (manifest["sap.app"] as { title?: unknown } | undefined)?.title;
  const text = i18nValue(manifest, webappDir, title) ?? fallback;
  return text.slice(0, DESCRIPTION_MAX);
}

/**
 * Why the repository refused the upload.
 *
 * The service answers with a whole upload log (`errordetails`): the generic sentence sits first,
 * the reason is buried in the lines after it, and the message header only carries the generic one.
 * So report every error-severity line plus the tail of the log — the part that explains it.
 */
function uploadErrorDetail(res: ODataResponse, sapMessage?: string): string {
  const error = (res.json as { error?: Record<string, unknown> } | undefined)?.error;
  // the REST error format nests the log under `innererror`, so look in both places
  const details =
    error?.errordetails ?? (error?.innererror as { errordetails?: unknown } | undefined)?.errordetails;
  if (Array.isArray(details) && details.length) {
    const rows = details.filter((d): d is { severity?: string; message?: string } => typeof d === "object" && d !== null);
    const errors = rows.filter((d) => d.severity === "error" && d.message).map((d) => d.message!);
    const log = rows.filter((d) => d.severity === "info" && d.message?.trim()).map((d) => d.message!);
    if (errors.length || log.length) return [...errors, ...log.slice(-14)].join("\n  ");
  }
  return sapMessage || res.text.slice(0, 1500);
}

/**
 * Validate → build → archive → upload → verify.
 *
 * Never prompts: a request to deploy is a request to publish. Failures are returned with the stage
 * they happened at, so a caller can tell "the manifest is broken" from "the system said no".
 */
export async function deployFioriApp(params: DeployParams): Promise<DeployResult> {
  const { config } = params;
  const timeout = params.timeoutMs ?? Math.max(config.requestTimeoutMs, 120000);
  const warnings: string[] = [];
  const appPath = path.resolve(params.appPath);

  const found = readAppManifest(appPath);
  if (!found) throw new Error(`No manifest.json found at or under ${appPath}.`);
  const { manifest, webappDir } = found;
  const appRoot = projectRootOf(appPath);
  const appFolderName = path.basename(webappDir === appPath ? appRoot : appRoot);

  const { target, inferred, warnings: targetWarnings } = await resolveDeployTarget(params, manifestServiceUris(manifest));
  warnings.push(...targetWarnings);

  const requested = params.bspName?.trim();
  let bsp: ReturnType<typeof sanitizeBspName>;
  if (requested) {
    validateBspName(requested);
    bsp = { name: requested.startsWith("/") ? requested : requested.toUpperCase(), warnings: [] };
  } else {
    bsp = sanitizeBspName(appFolderName);
  }
  warnings.push(...bsp.warnings);
  if (bsp.adjustedFrom) warnings.push(`BSP name adjusted from '${bsp.adjustedFrom}' to '${bsp.name}'.`);

  const abapPackage = params.abapPackage?.trim() || "$TMP";
  const description = params.description?.trim() || descriptionFor(manifest, webappDir, appFolderName);

  const base: Omit<DeployResult, "action" | "httpStatus" | "ok" | "verification" | "archive" | "appUrl" | "sapMessage" | "build" | "bootstrap"> = {
    stage: "build",
    target: {
      source: target.source,
      kind: target.source.startsWith("destination:") ? "destination" : "system",
      name: target.source.split(":").slice(1).join(":"),
      url: target.url,
      inferred
    },
    bsp: { name: bsp.name, adjustedFrom: bsp.adjustedFrom, package: abapPackage, transport: params.transport, description },
    warnings,
    nextSteps: []
  };

  // --- build ----------------------------------------------------------------
  const build: BuildOutcome = await buildApp(appPath, {
    skipBuild: params.skipBuild,
    install: params.install,
    timeoutMs: timeout
  });
  warnings.push(...build.warnings);

  // --- bootstrap ------------------------------------------------------------
  const bootstrapMode = params.bootstrap ?? "cdn";
  const indexHtmlPath = path.join(build.dir, "index.html");
  let indexHtml = "";
  try {
    indexHtml = await fsp.readFile(indexHtmlPath, "utf8");
  } catch {
    warnings.push(`No index.html in ${build.dir}: the deployed app will not start in a browser.`);
  }
  let bootstrap: DeployResult["bootstrap"] = { mode: bootstrapMode, changed: false };
  if (indexHtml && bootstrapMode !== "keep") {
    const version = appUi5Version(manifest, appRoot);
    let localRoot: string | undefined;
    if (bootstrapMode === "local") {
      localRoot = (await probeLocalResources(target.trustedUrls[0] ?? target.url, target, config, timeout)) ?? undefined;
      if (!localRoot) {
        warnings.push("The system does not serve a UI5 framework locally: falling back to the CDN bootstrap.");
      }
    }
    const rewritten = rewriteBootstrap(indexHtml, { mode: bootstrapMode, localRoot, version });
    bootstrap = {
      mode: localRoot ? "local" : bootstrapMode,
      from: rewritten.from,
      to: rewritten.to,
      changed: rewritten.changed
    };
    if (rewritten.changed) warnings.push(`index.html bootstrap rewritten: '${rewritten.from}' → '${rewritten.to}'.`);
    indexHtml = rewritten.html;
  }

  // --- archive --------------------------------------------------------------
  const override = indexHtml && bootstrap.changed ? [{ path: "index.html", content: indexHtml }] : [];
  const { buffer, files } = await zipFolder(build.dir, override);

  // --- does it already exist? ----------------------------------------------
  const infoUrl = `${target.url.replace(/\/$/, "")}/Repositories('${bsp.name}')?$format=json`;
  const info = await odataRequest({
    url: infoUrl,
    system: target.system,
    headers: target.headers,
    accept: "application/json",
    timeoutMs: timeout,
    config,
    trustedUrls: target.trustedUrls
  });
  if (info.status !== 200 && info.status !== 404) {
    const detail = uploadErrorDetail(info, info.headers["sap-message"]);
    throw new Error(
      `The system refused to describe repository '${bsp.name}' (HTTP ${info.status}). ${detail}` +
        (info.status === 403
          ? " That is an authorization problem: the user needs the UI5 Repository service (check SU53 after the attempt)."
          : "")
    );
  }
  const exists = info.status === 200;

  // --- upload ---------------------------------------------------------------
  const serviceRoot = target.url.replace(/\/$/, "");
  // `format`, not `$format`: on a create/update IWFND rejects SystemQueryOptions outright
  // ("contains SystemQueryOptions that are not allowed for this Request Type"), while a bare
  // `format=json` is an ordinary custom parameter — which is what SAP's own client sends.
  const query = [`CodePage='UTF8'`, "CondenseMessagesInHttpResponseHeader=X", "format=json"];
  if (params.transport) query.push(`TransportRequest=${encodeURIComponent(params.transport)}`);
  const uploadUrl = exists ? `${serviceRoot}/Repositories('${bsp.name}')` : `${serviceRoot}/Repositories`;
  const body = repositoryPayload({ serviceUrl: serviceRoot, name: bsp.name, description, abapPackage, zip: buffer });

  const upload = await odataRequest({
    url: `${uploadUrl}?${query.join("&")}`,
    method: exists ? "PUT" : "POST",
    system: target.system,
    headers: { ...target.headers, "content-type": "application/atom+xml; type=entry; charset=UTF8" },
    body,
    // the repository service validates the token (and the session it was minted in) on every write
    csrf: true,
    csrfUrl: `${serviceRoot}/$metadata`,
    accept: "application/json,application/xml",
    timeoutMs: timeout,
    config,
    trustedUrls: target.trustedUrls
  });
  const sapMessage = upload.headers["sap-message"];
  if (upload.status < 200 || upload.status >= 300) {
    throw new Error(
      `Upload of '${bsp.name}' failed (HTTP ${upload.status}). ${uploadErrorDetail(upload, sapMessage)}` +
        (params.transport ? "" : " If the package is not local ($TMP), pass a transport request in `transport`.")
    );
  }
  logger.info("deploy: repository upload", { name: bsp.name, status: upload.status, exists, source: target.source });

  // --- verify ---------------------------------------------------------------
  const appUrl = frontendAppUrl(target.trustedUrls[0] ?? target.url, bsp.name, target.system?.client);
  let verification: DeployResult["verification"] = { attempted: false, ok: false };
  if (params.verify !== false) {
    // A browser arrives at this URL with no credentials in hand, so the anonymous answer is the one
    // that matters; credentials are the fallback for systems that protect their UI5 repository.
    const attempts: { label: string; system?: typeof target.system; headers: Record<string, string> }[] = [
      { label: "anonymously", headers: {} },
      { label: "with credentials", system: target.system, headers: target.headers }
    ];
    let lastStatus: number | undefined;
    let contentType: string | undefined;
    let note: string | undefined;
    let ok = false;
    for (const attempt of attempts) {
      try {
        const res = await odataRequest({
          url: appUrl,
          system: attempt.system,
          headers: attempt.headers,
          accept: "text/html,application/xhtml+xml,*/*",
          timeoutMs: timeout,
          config,
          trustedUrls: [...target.trustedUrls, appUrl]
        });
        lastStatus = res.status;
        contentType = res.headers["content-type"];
        if (res.status === 200) {
          ok = true;
          note =
            attempt.label === "with credentials"
              ? `The system protects this URL: it answers 200 ${attempt.label}, so a browser will ask for sign-in.`
              : undefined;
          break;
        }
        note = `The upload succeeded but ${appUrl} answered HTTP ${res.status} ${attempt.label}. Check the ICF node /ui5 and the application's authorization.`;
        // 404 says the application is not there: no second attempt can change that
        if (res.status !== 401 && res.status !== 403) break;
      } catch (e) {
        note = `Could not fetch ${appUrl}: ${e instanceof Error ? e.message : String(e)}`;
        break;
      }
    }
    verification = { attempted: true, ok, status: lastStatus, contentType, note };
    if (!ok && note) warnings.push(note);
  }

  if (params.bootstrapCheck !== false && bootstrap.mode === "cdn" && bootstrap.to) {
    bootstrap.checked = true;
    bootstrap.checkedOk = await headOk(bootstrap.to, config, [], timeout);
    if (!bootstrap.checkedOk) warnings.push(`The pinned UI5 CDN build ${bootstrap.to} did not answer HEAD: check the version.`);
  }

  return {
    ...base,
    ok: verification.attempted ? verification.ok : true,
    stage: "verify",
    action: exists ? "updated" : "created",
    httpStatus: upload.status,
    appUrl,
    build: { mode: build.mode, built: build.built, durationMs: build.durationMs, root: build.dir },
    archive: { bytes: buffer.length, files: files.length },
    bootstrap,
    verification,
    sapMessage,
    nextSteps: [
      `Open ${appUrl}`,
      "Add a tile/target mapping in the launchpad if the app should appear as a tile.",
      "Redeploy after changes with deploy_fiori_app: the BSP is updated in place."
    ]
  };
}
