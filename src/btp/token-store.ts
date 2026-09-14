/**
 * Where a refresh token lives between runs.
 *
 * Everything else this server keeps out of its own files, because a password in a config file is
 * a copy the operator stops thinking about. A refresh token is different in one way that matters:
 * it is minted by this tool, not typed by a person, so leaving it to be pasted into an
 * environment variable adds a manual step for a value nobody chose. Storing it is the friendlier
 * default, provided the stored form is useless to anyone else.
 *
 * On Windows that is DPAPI, which ties the blob to this Windows user: another account on the same
 * machine cannot read it, and neither can a copy of the file taken elsewhere. Elsewhere there is no
 * equivalent the platform guarantees, so the token is written in the clear with owner-only
 * permissions and the caller is told plainly.
 *
 * DPAPI is reached through .NET's ProtectedData rather than ConvertTo-SecureString, because the
 * cmdlet lives in Microsoft.PowerShell.Security and that module does not always load: a shell whose
 * PSModulePath or module cache is in a bad state answers CommandNotFoundException, sealing fails,
 * and the token lands in the clear on a machine where DPAPI was available the whole time. The type
 * is part of the framework, so nothing has to be found for it to work.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

export type SealKind = "dpapi" | "plain";

interface StoredToken {
  destination: string;
  kind: SealKind;
  value: string;
  storedAt: string;
}

const isWindows = process.platform === "win32";

function tokensDir(dataDir: string): string {
  return path.join(dataDir, "tokens");
}

function tokenFile(dataDir: string, destination: string): string {
  const safe = destination.replace(/[^A-Za-z0-9._-]/g, "_");
  return path.join(tokensDir(dataDir), `${safe}.json`);
}

/** Run PowerShell with the payload in the environment, never on a command line. */
function powershell(script: string, payload: string): string {
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    env: { ...process.env, MCP_TOKEN_PAYLOAD: payload },
    encoding: "utf8",
    windowsHide: true,
    timeout: 20000
  }).trim();
}

// base64 in and out of PowerShell: the payload never touches a command line, and the result never
// depends on what the console happens to be encoding today
const SEAL_SCRIPT =
  "Add-Type -AssemblyName System.Security; " +
  "[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect(" +
  "[Text.Encoding]::UTF8.GetBytes($env:MCP_TOKEN_PAYLOAD), $null, 'CurrentUser'))";

const UNSEAL_SCRIPT =
  "Add-Type -AssemblyName System.Security; " +
  "[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect(" +
  "[Convert]::FromBase64String($env:MCP_TOKEN_PAYLOAD), $null, 'CurrentUser'))";

/** The SecureString format written by earlier versions: hex, and nothing else. */
const LEGACY_BLOB = /^[0-9a-fA-F]+$/;

const UNSEAL_LEGACY_SCRIPT =
  "[Runtime.InteropServices.Marshal]::PtrToStringBSTR(" +
  "[Runtime.InteropServices.Marshal]::SecureStringToBSTR((ConvertTo-SecureString -String $env:MCP_TOKEN_PAYLOAD)))";

function seal(value: string): { kind: SealKind; value: string; sealError?: string } {
  if (!isWindows) return { kind: "plain", value };
  try {
    const sealed = powershell(SEAL_SCRIPT, value);
    if (sealed) return { kind: "dpapi", value: sealed };
    return { kind: "plain", value, sealError: "PowerShell returned no DPAPI blob." };
  } catch (e) {
    // never swallow this: a token believed to be sealed and sitting in the clear is the one
    // outcome the operator must not have to guess at
    return { kind: "plain", value, sealError: e instanceof Error ? e.message.split(/\r?\n/)[0] : String(e) };
  }
}

function unseal(stored: StoredToken): string {
  if (stored.kind === "plain") return stored.value;
  if (LEGACY_BLOB.test(stored.value)) return powershell(UNSEAL_LEGACY_SCRIPT, stored.value);
  return Buffer.from(powershell(UNSEAL_SCRIPT, stored.value), "base64").toString("utf8");
}

export interface SaveResult {
  file: string;
  kind: SealKind;
  /** Why the token could not be sealed, when Windows was supposed to be able to seal it. */
  sealError?: string;
}

export function saveRefreshToken(dataDir: string, destination: string, token: string): SaveResult {
  const dir = tokensDir(dataDir);
  fs.mkdirSync(dir, { recursive: true });
  const sealed = seal(token);
  const file = tokenFile(dataDir, destination);
  const body: StoredToken = { destination, kind: sealed.kind, value: sealed.value, storedAt: new Date().toISOString() };
  fs.writeFileSync(file, JSON.stringify(body, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600); // no-op on Windows, where the DPAPI blob is the protection
  } catch {
    /* best effort */
  }
  return { file, kind: sealed.kind, ...(sealed.sealError ? { sealError: sealed.sealError } : {}) };
}

/** The stored token for a destination, or null when there is none or it cannot be read. */
export function readRefreshToken(dataDir: string, destination: string): string | null {
  const file = tokenFile(dataDir, destination);
  let stored: StoredToken;
  try {
    stored = JSON.parse(fs.readFileSync(file, "utf8")) as StoredToken;
  } catch {
    return null;
  }
  try {
    return unseal(stored) || null;
  } catch {
    // a DPAPI blob sealed by another Windows user, or on another machine, cannot be opened here
    return null;
  }
}

export function forgetRefreshToken(dataDir: string, destination: string): boolean {
  const file = tokenFile(dataDir, destination);
  if (!fs.existsSync(file)) return false;
  fs.rmSync(file);
  return true;
}

/** What the panel may show: whether a token is stored and how, never the token. */
export function describeStoredToken(dataDir: string, destination: string): { stored: boolean; kind?: SealKind; storedAt?: string } {
  try {
    const stored = JSON.parse(fs.readFileSync(tokenFile(dataDir, destination), "utf8")) as StoredToken;
    return { stored: true, kind: stored.kind, storedAt: stored.storedAt };
  } catch {
    return { stored: false };
  }
}
