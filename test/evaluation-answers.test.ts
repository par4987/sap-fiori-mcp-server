/**
 * Keeps eval/evaluation.xml honest.
 *
 * The evaluation answers are derived from the bundled bookshop example, so they rot silently if
 * anyone edits that fixture. Each test below re-derives one answer by calling the real tools and
 * compares it with what the XML claims. If one fails, fix the XML — not the test.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig, type AppConfig } from "../src/config.js";
import { createMcpServer } from "../src/server.js";
import { EXAMPLE_ROOT } from "./example-root.js";

const EVAL_FILE = path.resolve(__dirname, "..", "eval", "evaluation.xml");

/** Expected answers in document order, parsed straight out of the evaluation file. */
function expectedAnswers(): string[] {
  const xml = fs.readFileSync(EVAL_FILE, "utf8");
  return [...xml.matchAll(/<answer>([\s\S]*?)<\/answer>/g)].map((m) => m[1].trim());
}

let client: Client;
let server: McpServer;
let answers: string[];

type Row = Record<string, number | string>;

beforeAll(async () => {
  answers = expectedAnswers();
  const config: AppConfig = { ...loadConfig([]), workspaceRoot: EXAMPLE_ROOT, logLevel: "off" };
  server = createMcpServer(config);
  client = new Client({ name: "eval-check", version: "1.0.0" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);
});

afterAll(async () => {
  await client?.close();
  await server?.close();
});

async function structured<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const res = await client.callTool({ name, arguments: args });
  expect(res.isError, `${name}: ${JSON.stringify(res.content)}`).toBeFalsy();
  return res.structuredContent as T;
}

const rows = (entityName: string) => structured<{ rows: Row[] }>("query_cap_data", { entityName, limit: 500 }).then((r) => r.rows);
const details = (definitionName: string) =>
  structured<{ shortName: string; includes: string[]; elements: Row[]; actions: Row[]; annotations: Record<string, string> }>(
    "get_cap_details",
    { definitionName }
  );

const inventory = (list: Row[], key: string) => {
  const totals: Record<string, number> = {};
  for (const b of list) totals[String(b[key])] = (totals[String(b[key])] ?? 0) + Number(b.stock) * Number(b.price);
  return totals;
};
const argMax = (totals: Record<string, number>) => Object.entries(totals).sort((a, b) => b[1] - a[1])[0][0];

describe("eval/evaluation.xml answers still hold", () => {
  it("has exactly 10 question/answer pairs", () => {
    const xml = fs.readFileSync(EVAL_FILE, "utf8");
    expect([...xml.matchAll(/<qa_pair>/g)]).toHaveLength(10);
    expect(answers).toHaveLength(10);
  });

  it("1. genre holding the largest inventory value", async () => {
    const [books, genres] = await Promise.all([rows("Books"), rows("Genres")]);
    const top = argMax(inventory(books, "genre_code"));
    expect(genres.find((g) => g.code === top)?.name).toBe(answers[0]);
  });

  it("2. birth year of the author with the largest inventory value", async () => {
    const [books, authors] = await Promise.all([rows("Books"), rows("Authors")]);
    const top = argMax(inventory(books, "author_ID"));
    expect(String(authors.find((a) => a.ID === top)?.dateOfBirth).slice(0, 4)).toBe(answers[1]);
  });

  it("3. the only persisted entity without the managed aspect", async () => {
    const found: string[] = [];
    for (const name of ["sap.demo.bookshop.Books", "sap.demo.bookshop.Authors", "sap.demo.bookshop.Genres"]) {
      const d = await details(name);
      if (!d.includes.includes("managed")) found.push(d.shortName);
    }
    expect(found).toEqual([answers[2]]);
  });

  it("4. key type of the entity that does not use a UUID key", async () => {
    const offenders: string[] = [];
    for (const name of ["sap.demo.bookshop.Books", "sap.demo.bookshop.Authors", "sap.demo.bookshop.Genres"]) {
      const d = await details(name);
      const key = d.elements[0]; // the key element is declared first in every entity of the example
      if (String(key.type) !== "UUID") offenders.push(String(key.type));
    }
    expect(offenders).toEqual([answers[3]]);
  });

  it("5. OData V4 base path implied by the service path annotation", async () => {
    const service = await details("CatalogService");
    expect(`/odata/v4/${service.annotations["path"].replace(/^\//, "")}/`).toBe(answers[4]);
  });

  it("6. the only to-many association in the persistence layer", async () => {
    const found: string[] = [];
    for (const name of ["sap.demo.bookshop.Books", "sap.demo.bookshop.Authors", "sap.demo.bookshop.Genres"]) {
      const d = await details(name);
      for (const el of d.elements) if (el.cardinality === "many") found.push(`${d.shortName}.${el.name}`);
    }
    expect(found).toEqual([answers[5]]);
  });

  it("7. type a service operation parameter resolves to in the database layer", async () => {
    const service = await details("CatalogService");
    expect(service.actions).toHaveLength(1);
    const params = service.actions[0].params as { name: string; type: string }[];
    // "book: Books:ID" points at a key of an exposed entity instead of a primitive type
    const reference = params.find((p) => p.type.includes(":"))!;
    const [entity, element] = reference.type.split(":");
    const exposed = await details(`CatalogService.${entity}`);
    const persisted = await details(String(exposed.projectionOn ?? entity));
    expect(persisted.elements.find((e) => e.name === element)?.type).toBe(answers[6]);
  });

  it("8. the analytical hybrid floorplan is OData V2 only", async () => {
    const { tools } = await client.listTools();
    const generate = tools.find((t) => t.name === "generate_fiori_app_odata")!;
    // the tool description is the only place a model can learn which version each floorplan needs
    expect(generate.description).toContain(`'analytical-list-page' (V${answers[7].charAt(0)})`);
  });

  it("9. earlier-born author among the titles added in March 2026", async () => {
    const [books, authors] = await Promise.all([rows("Books"), rows("Authors")]);
    const dob = Object.fromEntries(authors.map((a) => [a.ID, String(a.dateOfBirth)]));
    const march = books
      .filter((b) => String(b.createdAt).startsWith("2026-03"))
      .sort((a, b) => dob[a.author_ID].localeCompare(dob[b.author_ID]));
    expect(march.length).toBeGreaterThan(1);
    expect(authors.find((a) => a.ID === march[0].author_ID)?.name).toBe(answers[8]);
  });

  it("10. lowest stock among titles sharing the priciest title's currency", async () => {
    const books = await rows("Books");
    const priciest = [...books].sort((a, b) => Number(b.price) - Number(a.price))[0];
    const sameCurrency = books
      .filter((b) => b.currency_code === priciest.currency_code)
      .sort((a, b) => Number(a.stock) - Number(b.stock));
    expect(sameCurrency[0].title).toBe(answers[9]);
  });
});
