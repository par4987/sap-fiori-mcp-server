/**
 * Pragmatic CDS (Core Schema Notation) parser.
 * Parses .cds sources into a unified model of definitions:
 * entities, services, types, aspects, events, actions, annotations and views.
 * Dependency-free: cursor based scanning with brace matching.
 */

export type CdsKind = "entity" | "service" | "type" | "aspect" | "event" | "action" | "function" | "annotation" | "annotate" | "view" | "extend" | "namespace";

export interface CdsActionParameter {
  name: string;
  /** Declared type, e.g. "Integer", "String(10)", "Books:ID" (a reference to an element). */
  type: string;
  /** True for "many X" / "array of X" parameters. */
  array?: boolean;
  default?: string;
  annotations: Record<string, string>;
}

export interface CdsElement {
  name: string;
  type: string;
  kind: "element" | "association" | "composition" | "action" | "function";
  target?: string;
  cardinality?: "one" | "many";
  on?: string;
  notNull?: boolean;
  isKey?: boolean;
  default?: string;
  annotations: Record<string, string>;
  array?: boolean;
  /** Declared parameters, for kind "action" / "function". */
  params?: CdsActionParameter[];
  /** True when the return type is "array of X" / "many X". */
  returnsMany?: boolean;
}

export interface CdsDefinition {
  name: string; // fully qualified (namespace + name or service-qualified)
  shortName: string;
  kind: CdsKind;
  source: string; // file path as provided
  line: number;
  namespace?: string;
  elements: CdsElement[];
  projectionOn?: string; // "as projection on X"
  selectFrom?: string; // "as select from X"
  includes?: string[]; // "include"/"extends"
  actions: CdsElement[];
  annotations: Record<string, string>;
  boundActions?: boolean;
}

export interface CdsModel {
  definitions: CdsDefinition[];
  namespaces: string[];
  usings: { file: string; imports: string[] }[];
  sources: string[];
}

interface ParsedFile {
  path: string;
  content: string;
}

export function stripCdsComments(src: string): string {
  // block comments
  let out = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  // line comments
  out = out.replace(/(^|[^:"'])\/\/[^\n]*/g, "$1");
  return out;
}

function lineOf(src: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < src.length; i++) if (src[i] === "\n") line++;
  return line;
}

/** Match a balanced {...} block starting at `start` (which must point at "{"). */
function matchBrace(src: string, start: number): { end: number; body: string } | null {
  let depth = 0;
  let inStr: string | null = null;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (inStr) {
      if (ch === inStr && src[i - 1] !== "\\") inStr = null;
      continue;
    }
    if (ch === "'" || ch === '"') inStr = ch;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return { end: i, body: src.slice(start + 1, i) };
    }
  }
  return null;
}

/** Split "a: 1, b: { c: 2 }, d" on commas that sit outside (), {}, [] and strings. */
function splitTopLevel(text: string, separator = ","): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote && text[i - 1] !== "\\") quote = null;
      continue;
    }
    if (c === "'" || c === '"') quote = c;
    else if (c === "(" || c === "{" || c === "[") depth++;
    else if (c === ")" || c === "}" || c === "]") depth--;
    else if (c === separator && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
}

/**
 * Expand the grouped annotation form into individual terms.
 *
 * `@(path: '/browse', requires: 'admin')` is the idiomatic way to write several annotations at
 * once in CDS — including the service `path` that decides the OData URL of a CAP service — and
 * the plain `@Term` regex below cannot see it, because there is no name right after the `@`.
 */
function parseAnnotationGroups(text: string, into: Record<string, string>): void {
  for (let i = text.indexOf("@("); i >= 0; i = text.indexOf("@(", i + 1)) {
    let depth = 0;
    let end = -1;
    for (let j = i + 1; j < text.length; j++) {
      if (text[j] === "(") depth++;
      else if (text[j] === ")" && --depth === 0) {
        end = j;
        break;
      }
    }
    if (end < 0) return; // unbalanced: nothing reliable to read
    for (const entry of splitTopLevel(text.slice(i + 2, end))) {
      const colon = findTopLevelColon(entry);
      const term = (colon >= 0 ? entry.slice(0, colon) : entry).trim().replace(/^@/, "");
      const value = colon >= 0 ? entry.slice(colon + 1).trim() : "";
      if (term) into[term] = value.replace(/^['"]|['"]$/g, "");
    }
    i = end;
  }
}

function parseAnnotations(text: string): Record<string, string> {
  const annotations: Record<string, string> = {};
  parseAnnotationGroups(text, annotations);
  // @Term or @Term(value) or @Term: value ... simplified: capture @Token chains
  const re = /@([\w.$/]+)\s*(?:\(([^()]*)\)|:\s*([^;]+?)(?=\s*(?:@(?:[\w.$/]+)|$))|(?=\s|$))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const term = m[1];
    const value = (m[2] ?? m[3] ?? "").trim();
    annotations[term] = value.replace(/^['"]|['"]$/g, "");
  }
  return annotations;
}

/** Find the first ':' that sits at nesting depth 0 (outside (), {}, [] and strings). */
function findTopLevelColon(text: string): number {
  let depth = 0;
  let inStr: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (ch === inStr && text[i - 1] !== "\\") inStr = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      inStr = ch;
    } else if (ch === "{" || ch === "(" || ch === "[") {
      depth++;
    } else if (ch === "}" || ch === ")" || ch === "]") {
      depth--;
    } else if (ch === ":" && depth === 0) {
      return i;
    }
  }
  return -1;
}

/** Parse an elements/actions body block into elements. */
/** Expand a file-local `using ... as alias` prefix so references stay resolvable model-wide. */
function resolveAlias(ref: string | undefined, aliases: Map<string, string>): string | undefined {
  if (!ref || !aliases.size) return ref;
  const dot = ref.indexOf(".");
  if (dot < 0) return ref; // bare name: nothing to expand
  const full = aliases.get(ref.slice(0, dot));
  return full ? `${full}${ref.slice(dot)}` : ref;
}

/**
 * Parse "action submitOrder(book: Books:ID, quantity: Integer) returns Decimal".
 *
 * The parameter list is scanned with a depth counter rather than a character class, because
 * parameter types carry their own parentheses ("String(10)", "Decimal(9,2)") — a `[^)]*` list
 * stops at the first inner ")" and made the whole declaration unrecognisable, so such actions
 * used to disappear from the model entirely.
 */
function parseActionSignature(part: string): CdsElement | null {
  const flat = part.replace(/\n/g, " ");
  const head = /(?:^|\s)(action|function)\s+([\w$]+)\s*\(/.exec(flat);
  if (!head) return null;

  const open = head.index + head[0].length - 1;
  let depth = 0;
  let close = -1;
  for (let i = open; i < flat.length; i++) {
    if (flat[i] === "(") depth++;
    else if (flat[i] === ")" && --depth === 0) {
      close = i;
      break;
    }
  }
  if (close < 0) return null; // unbalanced parameter list

  const returnsMatch = /^\s*returns\s+([^;{]+?)(?:\s*\{[\s\S]*\})?\s*$/s.exec(flat.slice(close + 1));
  let type = (returnsMatch?.[1] ?? "").trim();
  let returnsMany = false;
  const manyReturn = /^(?:array\s+of|many)\s+(.+)$/s.exec(type);
  if (manyReturn) {
    returnsMany = true;
    type = manyReturn[1].trim();
  }

  return {
    name: head[2],
    type: type || "empty",
    kind: head[1] as "action" | "function",
    annotations: parseAnnotations(flat.slice(0, head.index)),
    params: parseActionParams(flat.slice(open + 1, close)),
    ...(returnsMany ? { returnsMany } : {})
  };
}

/** Split a parameter list into name/type pairs, keeping annotations, defaults and arrays. */
function parseActionParams(list: string): CdsActionParameter[] {
  const params: CdsActionParameter[] = [];
  for (const entry of splitTopLevel(list)) {
    const colon = findTopLevelColon(entry);
    if (colon < 0) continue; // a parameter with no type is nothing we can describe
    const left = entry.slice(0, colon);
    const nameMatch = /([\w$]+)\s*$/.exec(left.replace(/@[\w.$/]+(?:\s*\([^()]*\))?/g, " "));
    if (!nameMatch) continue;

    let type = entry.slice(colon + 1).trim();
    let array = false;
    const many = /^(?:array\s+of|many)\s+(.+)$/s.exec(type);
    if (many) {
      array = true;
      type = many[1].trim();
    }
    let defaultValue: string | undefined;
    const def = /\s+default\s+(.+)$/s.exec(type);
    if (def) {
      defaultValue = def[1].trim().replace(/^['"]|['"]$/g, "");
      type = type.slice(0, def.index).trim();
    }

    params.push({
      name: nameMatch[1],
      type,
      ...(array ? { array } : {}),
      ...(defaultValue !== undefined ? { default: defaultValue } : {}),
      annotations: parseAnnotations(left)
    });
  }
  return params;
}

export function parseBody(body: string, isService = false): { elements: CdsElement[]; actions: CdsElement[] } {
  const elements: CdsElement[] = [];
  const actions: CdsElement[] = [];
  // split by ';' at depth 0 (respect nested braces/parens/strings)
  const parts: string[] = [];
  let depth = 0;
  let inStr: string | null = null;
  let current = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (inStr) {
      current += ch;
      if (ch === inStr && body[i - 1] !== "\\") inStr = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      inStr = ch;
      current += ch;
    } else if (ch === "{" || ch === "(" || ch === "[") {
      depth++;
      current += ch;
    } else if (ch === "}" || ch === ")" || ch === "]") {
      depth--;
      current += ch;
    } else if (ch === ";" && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current);

  for (const rawPart of parts) {
    const part = rawPart.trim();
    if (!part) continue;

    // actions / functions
    const action = parseActionSignature(part);
    if (action) {
      actions.push(action);
      continue;
    }

    // element: [annotations] [key] name : type ... possibly "Association to X on ..." or "Composition of many X"
    // find first top-level ':' (outside (), {}, [], strings)
    const colonIdx = findTopLevelColon(part);
    if (colonIdx < 0) continue;
    const left = part.slice(0, colonIdx).trim();
    const typePart0 = part.slice(colonIdx + 1).trim();
    // name = last plain word on the left once annotation tokens are stripped
    const leftNoAnn = left.replace(/@[\w.$/]+(?:\s*\([^()]*\))?/g, " ").replace(/\bkey\b/gi, " ").trim();
    const nameMatch = /([\w$]+)\s*$/.exec(leftNoAnn);
    if (!nameMatch) continue;
    const name = nameMatch[1];
    const annotationsPart = left.slice(0, Math.max(0, left.length - left.slice(left.lastIndexOf(name)).length));
    let typePart = typePart0;

    const isKey = /\bkey\b/i.test(left);

    let kind: CdsElement["kind"] = "element";
    let target: string | undefined;
    let cardinality: "one" | "many" | undefined;
    let on: string | undefined;
    let isNotNull = false;
    let defaultValue: string | undefined;
    let array = false;

    const assocMatch = /^(Association|Composition)\s+(?:to\s+(many\s+)?|of\s+(many\s+)?)([\w.$]+)\s*(?:\bon\b\s+([\s\S]+))?$/s.exec(typePart);
    if (assocMatch) {
      kind = assocMatch[1] === "Association" ? "association" : "composition";
      cardinality = assocMatch[2] || assocMatch[3] ? "many" : "one";
      target = assocMatch[4];
      on = assocMatch[5]?.trim();
      typePart = `${assocMatch[1]} to ${cardinality === "many" ? "many " : ""}${assocMatch[4]}`;
    } else {
      if (/^array\s+of\s+/i.test(typePart)) {
        array = true;
        typePart = typePart.replace(/^array\s+of\s+/i, "");
      }
      if (/\bnot\s+null\b/i.test(typePart)) {
        isNotNull = true;
        typePart = typePart.replace(/\bnot\s+null\b/i, "").trim();
      }
      const defMatch = /\bdefault\s+(.+)$/is.exec(typePart);
      if (defMatch) {
        defaultValue = defMatch[1].trim().replace(/;$/, "");
        typePart = typePart.replace(/\bdefault\s+.+$/is, "").trim();
      }
      typePart = typePart.trim();
    }

    const annotations = parseAnnotations(annotationsPart);
    // also merge annotations that appear after the name (annotate syntax: "title @UI.LineItem: [...];")
    const allAnnotations = parseAnnotations(part);
    for (const [k, v] of Object.entries(allAnnotations)) {
      if (!annotations[k]) annotations[k] = v;
    }
    elements.push({
      name,
      type: typePart.replace(/;+\s*$/, "").trim(),
      kind,
      target,
      cardinality,
      on,
      notNull: isNotNull || undefined,
      isKey: isKey || undefined,
      default: defaultValue,
      annotations,
      array: array || undefined
    });
  }
  return { elements, actions };
}

const DEF_RE = /\b(entity|service|type|aspect|event|extend|annotate)\b\s+([\w.$]+|`[^`]+`)/g;

/** Parse a single .cds source into definitions. */
export function parseCdsSource(src: string, filePath: string, model: CdsModel): void {
  const text = stripCdsComments(src);

  // namespace
  const nsMatch = /\bnamespace\s+([\w.$]+)\s*;/.exec(text);
  const namespace = nsMatch?.[1];
  if (namespace && !model.namespaces.includes(namespace)) model.namespaces.push(namespace);

  // usings: "using { sap.demo.bookshop as bookshop } from '../db/schema'" makes `bookshop` a
  // file-local alias, and references written through it are dead ends unless they are expanded
  const aliases = new Map<string, string>();
  const usingRe = /\busing\s*(?:\{([^}]*)\}\s*)?from\s*(?:'([^']+)'|"([^"]+)")/g;
  let um: RegExpExecArray | null;
  while ((um = usingRe.exec(text)) !== null) {
    const imports = (um[1] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => {
        const asMatch = /^(.+?)\s+as\s+([\w.$]+)$/.exec(s);
        return asMatch ? `${asMatch[1]} as ${asMatch[2]}` : s;
      });
    if (imports.length || um[2] || um[3]) model.usings.push({ file: filePath, imports: imports.length ? imports : [(um[2] ?? um[3] ?? "").trim()] });
    for (const imp of imports) {
      const asMatch = /^(.+?)\s+as\s+([\w.$]+)$/.exec(imp);
      if (asMatch) aliases.set(asMatch[2], asMatch[1].trim());
    }
  }

  DEF_RE.lastIndex = 0;
  let def: RegExpExecArray | null;
  while ((def = DEF_RE.exec(text)) !== null) {
    const kind = def[1] as CdsKind;
    const rawName = def[2].replace(/`/g, "");
    const startIdx = def.index;

    // annotations: scan backwards from def for preceding @(...)/@Term block on same statement
    const before = text.slice(Math.max(0, startIdx - 400), startIdx);
    const lastSemi = Math.max(before.lastIndexOf(";"), before.lastIndexOf("}"));
    const annotationText = before.slice(lastSemi + 1);
    const defAnnotations = parseAnnotations(annotationText);

    // find optional body or "as projection/select"
    let i = def.index + def[0].length;
    let bodyBody: string | null = null;
    let projectionOn: string | undefined;
    let selectFrom: string | undefined;
    let includes: string[] = [];

    const skipWs = () => {
      while (i < text.length && /\s/.test(text[i])) i++;
    };

    skipWs();
    // optional includes clause after ':' e.g. "entity Books : managed, Other { ... }"
    if (text[i] === ":") {
      const rest = text.slice(i + 1);
      const m = /^\s*([\w.$\s,]+?)(?=\{|;|@|$)/.exec(rest);
      if (m) {
        includes = m[1].split(",").map((s) => s.trim()).filter(Boolean);
        i += 1 + m[0].length;
        skipWs();
      }
    }
    // optional "include"/"extends" keyword clause
    if (/^(include|extends)\b/.test(text.slice(i))) {
      const m = /^(?:include|extends)\s+([\w.$\s,]+?)(?=\{|;|@|$)/.exec(text.slice(i));
      if (m) {
        includes.push(...m[1].split(",").map((s) => s.trim()).filter(Boolean));
        i += m[0].length;
        skipWs();
      }
    }
    // optional "with" keyword (annotate X with { ... })
    if (/^with\b/.test(text.slice(i))) {
      i += 4;
      skipWs();
    }
    // annotation between the name and the body, e.g. service X @(path:'/browse') { ... }
    // it must be parsed, not just skipped: @path decides the OData URL of a CAP service
    while (text[i] === "@") {
      const annStart = i;
      if (text[i + 1] === "(") {
        let depth = 0;
        let j = i + 1;
        for (; j < text.length; j++) {
          if (text[j] === "(") depth++;
          else if (text[j] === ")") {
            depth--;
            if (depth === 0) break;
          }
        }
        i = j + 1;
      } else {
        i++;
        while (i < text.length && /[\w.$]/.test(text[i])) i++;
      }
      Object.assign(defAnnotations, parseAnnotations(text.slice(annStart, i)));
      skipWs();
    }
    // optional "as projection on X" / "as select from X"
    const projMatch = /^as\s+(projection|select)\s+(?:on|from)\s+([\w.$]+)/.exec(text.slice(i));
    if (projMatch) {
      if (projMatch[1] === "projection") projectionOn = projMatch[2];
      else selectFrom = projMatch[2];
      i += projMatch[0].length;
      skipWs();
    }
    // optional { body }
    let bodyStart = -1;
    if (text[i] === "{") {
      const matched = matchBrace(text, i);
      if (matched) {
        bodyBody = matched.body;
        bodyStart = i + 1; // offsets inside bodyBody are relative to this, not to the name
        DEF_RE.lastIndex = matched.end + 1; // continue scanning after body
      }
    }

    const fqName = namespace && kind !== "service" && !rawName.includes(".") ? `${namespace}.${rawName}` : rawName;
    const parsed = bodyBody ? parseBody(bodyBody, kind === "service") : { elements: [], actions: [] };

    // "as select from" may carry a { ... } projection list — handled as body via match above if present

    const definition: CdsDefinition = {
      name: fqName,
      shortName: fqName.split(".").pop()!,
      kind: kind === "entity" && (projectionOn || selectFrom) ? "view" : kind,
      source: filePath,
      line: lineOf(src, def.index),
      namespace,
      elements: kind === "service" ? parsed.elements : parsed.elements,
      projectionOn: resolveAlias(projectionOn, aliases),
      selectFrom: resolveAlias(selectFrom, aliases),
      includes,
      actions: parsed.actions,
      annotations: defAnnotations
    };

    // if a service body contains "entity X as projection on Y", those nested entities
    const nestedEntityRe = /\bentity\s+([\w$]+)\s+as\s+(projection|select)\s+(?:on|from)\s+([\w.$]+)/g;
    let nm: RegExpExecArray | null;
    while (kind === "service" && bodyBody && (nm = nestedEntityRe.exec(bodyBody)) !== null) {
      const nestedName = `${fqName}.${nm[1]}`;
      const beforeNested = bodyBody.slice(0, nm.index);
      const nestedAnnStart = Math.max(beforeNested.lastIndexOf(";"), beforeNested.lastIndexOf("}")) + 1;
      model.definitions.push({
        name: nestedName,
        shortName: nm[1],
        kind: "view",
        source: filePath,
        line: lineOf(src, bodyStart + nm.index),
        namespace,
        elements: [],
        projectionOn: resolveAlias(nm[3], aliases),
        selectFrom: nm[1] === "select" ? resolveAlias(nm[3], aliases) : undefined,
        includes: [],
        actions: [],
        annotations: parseAnnotations(beforeNested.slice(nestedAnnStart))
      });
    }

    model.definitions.push(definition);
  }
}

/** Parse multiple .cds files into one unified model. */
export function parseCdsSources(files: ParsedFile[]): CdsModel {
  const model: CdsModel = { definitions: [], namespaces: [], usings: [], sources: files.map((f) => f.path) };
  for (const file of files) {
    try {
      parseCdsSource(file.content, file.path, model);
    } catch {
      // a malformed file must not break the whole model; skip it
    }
  }
  // attach `annotate` statements to their targets
  const annotateDefs = model.definitions.filter((d) => d.kind === "annotation" || d.kind === "annotate");
  for (const ann of annotateDefs) {
    const target = model.definitions.find(
      (d) => d !== ann && (d.name === ann.shortName || d.shortName === ann.shortName || d.name === ann.name)
    );
    if (target) {
      Object.assign(target.annotations, ann.annotations);
      for (const el of ann.elements) {
        const targetEl = target.elements.find((e) => e.name === el.name);
        if (targetEl) Object.assign(targetEl.annotations, el.annotations);
        else target.elements.push(el);
      }
    }
  }
  model.definitions = model.definitions.filter((d) => d.kind !== "annotation" && d.kind !== "annotate");
  return model;
}
