/**
 * Lightweight, dependency-free text search over a document corpus.
 * Implements BM25-style scoring with fuzzy word matching (prefix + subsequence),
 * so queries like "annotacion list report" still hit annotation documentation.
 */

export interface DocEntry {
  id: string;
  title: string;
  /** short human keywords shown in results */
  tags?: string[];
  body: string;
  /** logical corpus, e.g. "fiori" | "ui5" | "cap" | "opa5" | "cards" | "typescript" */
  corpus: string;
}

export interface DocHit extends DocEntry {
  score: number;
  snippet: string;
}

const STOPWORDS = new Set([
  "the", "a", "an", "of", "to", "in", "on", "for", "and", "or", "is", "are", "be", "with", "as", "by", "it", "this", "that", "how", "do", "i", "you", "we"
]);

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9.]+/g, " ")
    .trim();
}

function tokenize(s: string): string[] {
  return normalize(s)
    .split(" ")
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/** subsequence check: "lrapp" matches "listreportapp" */
function isSubsequence(needle: string, hay: string): boolean {
  let i = 0;
  for (let j = 0; j < hay.length && i < needle.length; j++) {
    if (hay[j] === needle[i]) i++;
  }
  return i === needle.length;
}

function wordScore(queryTerm: string, tokens: string[], raw: string): number {
  let score = 0;
  for (const tok of tokens) {
    if (tok === queryTerm) score += 3;
    else if (tok.startsWith(queryTerm)) score += 2;
    else if (queryTerm.length >= 4 && tok.includes(queryTerm)) score += 1.5;
    else if (isSubsequence(queryTerm, tok) && queryTerm.length >= 4) score += 0.75;
  }
  // title field double weight
  return score;
}

export function searchDocs(corpus: DocEntry[], query: string, limit = 8, scopes?: string[]): DocHit[] {
  const pool = scopes && scopes.length ? corpus.filter((d) => scopes.includes(d.corpus)) : corpus;
  const qTerms = tokenize(query);
  if (!qTerms.length) return pool.slice(0, limit).map((d) => ({ ...d, score: 0, snippet: d.body.slice(0, 220) }));

  const hits: DocHit[] = [];
  for (const doc of pool) {
    const titleTokens = tokenize(doc.title);
    const bodyTokens = tokenize(doc.body);
    const tagText = (doc.tags ?? []).join(" ");
    const tagTokens = tokenize(tagText);

    let score = 0;
    for (const qt of qTerms) {
      score += 3 * wordScore(qt, titleTokens, doc.title);
      score += 1 * wordScore(qt, bodyTokens, doc.body);
      score += 2.5 * wordScore(qt, tagTokens, tagText);
    }
    if (score > 0) {
      const snippet = makeSnippet(doc.body, qTerms);
      hits.push({ ...doc, score: Math.round(score * 100) / 100, snippet });
    }
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit);
}

function makeSnippet(body: string, terms: string[], radius = 120): string {
  const norm = normalize(body);
  const rawLower = body.toLowerCase();
  for (const t of terms) {
    const idx = rawLower.indexOf(t.length > 3 ? t.slice(0, Math.max(4, t.length - 1)) : t);
    if (idx >= 0) {
      const start = Math.max(0, idx - radius / 2);
      const end = Math.min(body.length, idx + radius);
      return (start > 0 ? "…" : "") + body.slice(start, end).replace(/\s+/g, " ").trim() + (end < body.length ? "…" : "");
    }
  }
  return body.slice(0, 220).replace(/\s+/g, " ").trim();
}

/** Fuzzy score for model/entity names (exact > prefix > word > substring > subsequence). */
export function fuzzyNameScore(query: string, name: string): number {
  const q = normalize(query).replace(/\s/g, "");
  const n = normalize(name).replace(/\s/g, "");
  if (!q) return 0;
  if (n === q) return 100;
  const parts = n.split(".");
  const short = parts[parts.length - 1];
  if (short === q || n === q) return 95;
  if (short.startsWith(q)) return 80;
  if (n.startsWith(q)) return 70;
  if (short.includes(q)) return 55;
  if (n.includes(q)) return 45;
  // camelCase word match: "BookOrder" ~ "book"
  const words = short.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(" ");
  if (words.some((w) => w === q)) return 65;
  if (words.some((w) => w.startsWith(q))) return 50;
  if (isSubsequence(q, short) && q.length >= 3) return 25;
  return 0;
}
