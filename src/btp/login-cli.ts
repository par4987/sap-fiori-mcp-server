/**
 * `--btp-login`: the one interactive step BTP needs, and nothing more.
 *
 * The refresh token is printed rather than written anywhere. This server keeps secrets in the
 * environment, not in its own files, and a token quietly saved to disk would be one more copy for
 * the operator to forget about. Printing it once, with the exact command to store it, keeps the
 * decision — and the copy — theirs.
 */
import type { AppConfig } from "../config.js";
import { loadDestinations } from "./destinations.js";
import { loginWithBrowser } from "./login.js";
import { readServiceKeyFile } from "./service-key.js";
import { saveRefreshToken } from "./token-store.js";

export interface BtpLoginOptions {
  keyPath: string;
  destination: string;
  noBrowser: boolean;
  config: AppConfig;
}

const out = (line = ""): void => void process.stdout.write(`${line}\n`);

/** Find the service key: given directly, or through the destination that already points at one. */
function resolveKeyPath(opts: BtpLoginOptions): string {
  if (opts.keyPath) return opts.keyPath;
  if (!opts.destination) {
    throw new Error(
      "Say which service key to sign in with: --key <service-key.json>, or --destination <name> for a destination that already carries one."
    );
  }
  const found = loadDestinations(opts.config).find((d) => d.name.toLowerCase() === opts.destination.toLowerCase());
  if (!found) {
    const names = loadDestinations(opts.config).map((d) => d.name);
    throw new Error(`No destination called '${opts.destination}'. Known: ${names.length ? names.join(", ") : "(none)"}.`);
  }
  if (!found.serviceKeyPath) {
    throw new Error(`Destination '${found.name}' has no serviceKeyPath, so there is no OAuth client to sign in with.`);
  }
  return found.serviceKeyPath;
}

export async function runBtpLogin(opts: BtpLoginOptions): Promise<void> {
  const keyPath = resolveKeyPath(opts);
  const key = readServiceKeyFile(keyPath);

  out();
  out(`Signing in to ${key.systemId ? `${key.systemId} — ` : ""}${key.tokenUrl}`);
  out(`OAuth client from ${keyPath}`);
  out();

  const result = await loginWithBrowser(key, {
    noBrowser: opts.noBrowser,
    onIdentityProvider: (host) => {
      out(`You will sign in at ${host}.`);
      out("Use the business user of that system — the one the ABAP system knows, such as CB99…—");
      out("not the SAP.com account used for the BTP cockpit. They are different populations.");
      out();
    },
    onUrl: (url) => {
      if (opts.noBrowser) {
        out("Open this URL in a browser to sign in:");
        out();
        out(`  ${url}`);
      } else {
        out("A browser window is opening. If it does not, open this URL yourself:");
        out();
        out(`  ${url}`);
      }
      out();
      out("Waiting for the callback…");
    }
  });

  const target = opts.destination || "default";
  const saved = saveRefreshToken(opts.config.dataDir, target, result.refreshToken);

  out();
  out(`Signed in. The refresh token now stands in for you, and it is stored for '${target}':`);
  out();
  out(`  ${saved.file}`);
  out(
    saved.kind === "dpapi"
      ? "  sealed with DPAPI — only this Windows user on this machine can read it"
      : "  stored in the clear with owner-only permissions; this platform offers no sealing this tool can rely on"
  );
  // on Windows, plain means sealing was attempted and failed — say what went wrong rather than
  // letting it read like a platform that never had DPAPI
  if (saved.sealError) out(`  DPAPI was expected to seal it and did not: ${saved.sealError}`);
  out();
  if (opts.destination) {
    out(`Set the destination's Authentication to OAuth2RefreshToken and it will use this token.`);
  } else {
    out("Run this again with --destination <name> to store the token for a specific destination,");
    out("or set the destination's refreshToken to ${env:NAME} to keep using an environment variable.");
  }
  out();
  out("Treat the stored file like a password: anything able to read it can act as you on that system.");
  out();
}
