/**
 * `${env:NAME}` references inside configuration files.
 *
 * A systems.json or destination file that carries a plain-text password has to be protected like
 * a secret: it ends up in backups, in screen shares, and one careless `git add` from a commit.
 * Writing `"password": "${env:SAP_A4H_PASSWORD}"` keeps the value in the environment instead,
 * and matches the convention other SAP tooling already uses for the same files.
 */

const REF = /\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** Replace every `${env:NAME}` in a string. Unset variables expand to "" and are reported. */
export function expandEnvRefs(value: string, missing?: Set<string>): string {
  return value.replace(REF, (_match, name: string) => {
    const resolved = process.env[name];
    if (resolved === undefined || resolved === "") {
      missing?.add(name);
      return "";
    }
    return resolved;
  });
}

/** Walk a parsed JSON value and expand `${env:NAME}` in every string it contains. */
export function expandEnvRefsDeep<T>(value: T, missing?: Set<string>): T {
  if (typeof value === "string") return expandEnvRefs(value, missing) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => expandEnvRefsDeep(v, missing)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = expandEnvRefsDeep(v, missing);
    return out as T;
  }
  return value;
}

/** One warning line naming the variables a config file referenced but the environment lacks. */
export function missingEnvWarning(source: string, missing: Set<string>): string | null {
  if (!missing.size) return null;
  const names = [...missing].sort();
  return `${source} references ${names.length === 1 ? "an environment variable that is not set" : "environment variables that are not set"}: ${names.join(", ")}. Those values expand to empty, so authentication will fail.`;
}
