/**
 * Minimal CQN-like query engine over CAP CSV mock data.
 * CAP stores sample data as CSV files named `<namespace>-<Entity>.csv` with a
 * header row. This engine loads a file, applies column selection, a WHERE-like
 * filter expression and skip/limit — mirroring the most common CQN SELECT use
 * cases an AI assistant needs.
 */

export interface CsvQuery {
  columns?: string[];
  filter?: string; // e.g. "stock > 10 and price lt 50", supports and/or, eq/ne/gt/ge/lt/le, contains, =
  orderBy?: { column: string; desc?: boolean }[];
  limit?: number;
  skip?: number;
}

export interface CsvQueryResult {
  rows: Record<string, unknown>[];
  count: number;
  columns: string[];
  file: string;
}

function parseCsv(content: string): { header: string[]; rows: string[][] } {
  const rows: string[][] = [];
  const header: string[] = [];
  let current: string[] = [];
  let field = "";
  let inQuotes = false;
  const lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const pushField = () => {
    current.push(field.trim());
    field = "";
  };
  const pushRow = () => {
    pushField();
    rows.push(current);
    current = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const ch = lines[i];
    if (inQuotes) {
      if (ch === '"') {
        if (lines[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      pushField();
    } else if (ch === "\n") {
      pushRow();
    } else {
      field += ch;
    }
  }
  if (field.length || current.length) pushRow();
  const [h, ...rest] = rows;
  return { header: h ?? [], rows: rest.filter((r) => r.some((c) => c !== "")) };
}

function coerce(value: string): unknown {
  const t = value.trim();
  if (t === "") return null;
  if (/^-?\d+$/.test(t)) return parseInt(t, 10);
  if (/^-?\d+\.\d+$/.test(t)) return parseFloat(t);
  if (/^(true|false)$/i.test(t)) return t.toLowerCase() === "true";
  return t;
}

type Cmp = (row: Record<string, unknown>) => boolean;

function compare(a: unknown, op: string, bRaw: string): boolean {
  let b: unknown = bRaw;
  if (typeof a === "number") b = parseFloat(bRaw);
  else if (typeof a === "boolean") b = bRaw.toLowerCase() === "true";
  else if (a instanceof Date) b = new Date(bRaw);
  switch (op) {
    case "eq":
    case "=":
    case "==":
      return a == b; // eslint-disable-line eqeqeq
    case "ne":
    case "!=":
    case "<>":
      return a != b; // eslint-disable-line eqeqeq
    case "gt":
    case ">":
      return (a as number) > (b as number);
    case "ge":
    case ">=":
      return (a as number) >= (b as number);
    case "lt":
    case "<":
      return (a as number) < (b as number);
    case "le":
    case "<=":
      return (a as number) <= (b as number);
    default:
      return false;
  }
}

/** Parse a CQN-ish / OData-ish filter expression into a predicate. */
export function compileFilter(expr: string): Cmp {
  // split on and/or at top level; groups are AND-combinations joined by OR
  const tokens = splitLogical(expr);
  const groups: Cmp[][] = [];
  let current: Cmp[] = [];
  for (const t of tokens) {
    if (t.op === "or") {
      if (current.length) groups.push(current);
      current = [];
    } else if (t.op === "and") {
      continue;
    } else {
      current.push(compileSimple(t.expr));
    }
  }
  if (current.length) groups.push(current);
  return (row) => groups.some((g) => g.every((pred) => pred(row)));
}

function splitLogical(expr: string): { op?: "and" | "or"; expr: string }[] {
  const out: { op?: "and" | "or"; expr: string }[] = [];
  const re = /\s+(and|or)\s+/gi;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(expr)) !== null) {
    out.push({ expr: expr.slice(last, m.index).trim(), op: undefined });
    out.push({ op: m[1].toLowerCase() as "and" | "or", expr: "" });
    last = m.index + m[0].length;
  }
  out.push({ expr: expr.slice(last).trim() });
  return out.filter((t) => t.expr || t.op);
}

function compileSimple(expr: string): Cmp {
  const trimmed = expr.trim();
  const containsMatch = /^contains\s*\(\s*([\w.$]+)\s*,\s*['"]([^'"]*)['"]\s*\)$/i.exec(trimmed);
  if (containsMatch) {
    const [, col, needle] = containsMatch;
    return (row) => String(row[col] ?? "").toLowerCase().includes(needle.toLowerCase());
  }
  const cmpMatch = /^([\w.$]+)\s*(eq|ne|gt|ge|lt|le|>=|<=|!=|<>|=|==|>|<)\s*(.+)$/i.exec(trimmed);
  if (cmpMatch) {
    const col = cmpMatch[1];
    const op = cmpMatch[2].toLowerCase();
    const raw = cmpMatch[3].trim().replace(/^['"]|['"]$/g, "");
    return (row) => compare(row[col], op, raw);
  }
  const isNull = /^([\w.$]+)\s+is\s+null$/i.exec(trimmed);
  if (isNull) {
    const col = isNull[1];
    return (row) => row[col] === null || row[col] === undefined || row[col] === "";
  }
  // bare value match: { title: "Cat" } style already handled elsewhere; treat "col: value"
  const jsonish = /^([\w.$]+)\s*:\s*(.+)$/.exec(trimmed);
  if (jsonish) {
    const col = jsonish[1];
    const raw = jsonish[2].trim().replace(/^['"]|['"]$/g, "");
    return (row) => compare(row[col], "eq", raw);
  }
  return () => true;
}

/** Execute a query over one CSV file (CAP mock data). */
export function queryCsv(content: string, file: string, query: CsvQuery): CsvQueryResult {
  const { header, rows } = parseCsv(content);
  const columns = query.columns?.length
    ? query.columns
    : header.map((h) => h.split(" as ")[0].trim());
  const predicates = query.filter ? compileFilter(query.filter) : () => true;
  const objects = rows
    .map((r) => {
      const obj: Record<string, unknown> = {};
      header.forEach((h, i) => {
        const key = h.split(" as ")[0].trim();
        obj[key] = coerce(r[i] ?? "");
      });
      return obj;
    })
    .filter(predicates);

  if (query.orderBy?.length) {
    objects.sort((a, b) => {
      for (const ord of query.orderBy!) {
        const av = a[ord.column];
        const bv = b[ord.column];
        const cmp =
          typeof av === "number" && typeof bv === "number"
            ? av - bv
            : String(av ?? "").localeCompare(String(bv ?? ""));
        if (cmp !== 0) return ord.desc ? -cmp : cmp;
      }
      return 0;
    });
  }

  const skip = query.skip ?? 0;
  const limit = query.limit ?? 100;
  const paged = objects.slice(skip, skip + limit);
  const projected = paged.map((row) => {
    if (!query.columns?.length) return row;
    const out: Record<string, unknown> = {};
    for (const c of query.columns) out[c] = row[c];
    return out;
  });
  return { rows: projected, count: objects.length, columns: query.columns?.length ? query.columns : header.map((h) => h.split(" as ")[0].trim()), file };
}
