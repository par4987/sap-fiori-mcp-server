/**
 * Minimal, dependency-free XML utilities sufficient for EDMX metadata and
 * light XML document analysis. Not a full DOM: purpose-built for tooling.
 */

export interface XmlElement {
  tag: string;
  attrs: Record<string, string>;
  children: XmlElement[];
  text: string;
}

/** Extract all elements with the given tag name via regex (non-greedy, no nesting guarantee). */
export function findElements(xml: string, tag: string, options?: { includeContent?: boolean }): { attrs: Record<string, string>; content: string }[] {
  const includeContent = options?.includeContent ?? true;
  const results: { attrs: Record<string, string>; content: string }[] = [];
  const openRe = new RegExp(`<${tag}(\\s[^>]*)?/?>`, "gi");
  let m: RegExpExecArray | null;
  while ((m = openRe.exec(xml)) !== null) {
    const selfClosing = m[0].endsWith("/>");
    const attrs = parseAttrs(m[1] ?? "");
    let content = "";
    if (includeContent && !selfClosing) {
      const closeRe = new RegExp(`</${tag}\\s*>`, "i");
      const rest = xml.slice(m.index + m[0].length);
      const closeMatch = closeRe.exec(rest);
      content = closeMatch ? rest.slice(0, closeMatch.index) : "";
    }
    results.push({ attrs, content });
  }
  return results;
}

export function parseAttrs(attrString: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(attrString)) !== null) {
    attrs[m[1]] = m[3] ?? m[4] ?? "";
  }
  return attrs;
}

export function attr(el: { attrs: Record<string, string> }, name: string): string | undefined {
  return el.attrs[name];
}

/** First attribute match among aliases, e.g. odata v2 vs v4 namespace prefixes. */
export function findAttr(el: { attrs: Record<string, string> }, ...aliases: string[]): string | undefined {
  for (const a of aliases) {
    if (el.attrs[a] !== undefined) return el.attrs[a];
  }
  // namespace-agnostic fallback: local name match
  for (const [k, v] of Object.entries(el.attrs)) {
    const local = k.split(":").pop()!;
    if (aliases.includes(local)) return v;
  }
  return undefined;
}

export function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
    .replace(/&amp;/g, "&");
}

/** Very small XML serializer for generated files. */
export function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
