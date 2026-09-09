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

  const store = process.platform === "win32" ? `setx BTP_REFRESH_TOKEN "${result.refreshToken}"` : `export BTP_REFRESH_TOKEN='${result.refreshToken}'`;

  out();
  out("Signed in. This refresh token stands in for you from now on:");
  out();
  out(`  ${result.refreshToken}`);
  out();
  out("Treat it like a password — anything holding it can act as you on that system.");
  out("Store it in the environment, which is where this server reads it from:");
  out();
  out(`  ${store}`);
  out();
  out("Then set the destination's Authentication to OAuth2RefreshToken. It reads BTP_REFRESH_TOKEN,");
  out('or the destination\'s own refreshToken field written as ${env:NAME}.');
  if (process.platform === "win32") {
    out();
    out("setx writes it for future processes: reopen the terminal (and this session) before testing.");
  }
  out();
}
