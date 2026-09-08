import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "../config.js";
import { searchAllDocs, guidelines } from "../docs/index.js";
import { json, err, paginate, READ_LOCAL } from "./index.js";
import { searchDocsOutput, guidelinesOutput } from "./schemas.js";

export function registerDocTools(server: McpServer, _config: AppConfig, name: (n: string) => string = (n) => n): void {
  server.registerTool(
    name("search_docs"),
    {
      title: "Search SAP documentation",
      description:
        "Searches the bundled documentation corpora for SAP Fiori elements, UI annotations, UI5 development, OPA5 testing, UI Integration Cards, TypeScript conversion, CAP (CDS) development and SAP BTP destinations. " +
        "Use this before generating or modifying apps to ground answers in current best practices. Local, no network required.",
      inputSchema: {
        query: z.string().min(1).describe("Search query, e.g. 'flexible column layout' or 'value help annotation'"),
        scope: z.enum(["all", "fiori", "ui5", "cap", "opa5", "cards", "typescript", "btp"]).default("all").describe("Restrict to one documentation corpus"),
        limit: z.number().int().min(1).max(20).default(6).describe("Maximum number of results per page"),
        offset: z.number().int().min(0).default(0).describe("Number of results to skip (use nextOffset from a previous call)")
      },
      outputSchema: searchDocsOutput,
      annotations: READ_LOCAL
    },
    async (args) => {
      try {
        const limit = args.limit ?? 6;
        const offset = args.offset ?? 0;
        // score the whole (bundled, small) corpus so `total` and `hasMore` describe every match
        const hits = searchAllDocs(args.query, Number.MAX_SAFE_INTEGER, args.scope ?? "all");
        const page = paginate(hits, limit, offset);
        return json({
          query: args.query,
          scope: args.scope ?? "all",
          count: page.count,
          total: page.total,
          offset: page.offset,
          hasMore: page.hasMore,
          nextOffset: page.nextOffset,
          results: page.items.map((h) => ({
            id: h.id,
            corpus: h.corpus,
            title: h.title,
            tags: h.tags ?? [],
            score: h.score,
            snippet: h.snippet,
            body: h.body
          }))
        });
      } catch (e) {
        return err(e);
      }
    }
  );

  server.registerTool(
    name("get_guidelines"),
    {
      title: "Get UI5 development guidelines",
      description: "Returns curated UI5 development best practices for a topic: general, views, bindings, routing, i18n, performance, security, testing.",
      inputSchema: {
        topic: z.enum(["general", "views", "bindings", "routing", "i18n", "performance", "security", "testing"]).default("general").describe("Guideline topic")
      },
      outputSchema: guidelinesOutput,
      annotations: READ_LOCAL
    },
    async (args) => {
      try {
        const topic = args.topic ?? "general";
        const g = guidelines[topic];
        if (!g) return err(new Error(`Unknown topic '${topic}'. Available: ${Object.keys(guidelines).join(", ")}.`));
        return json({ topic, title: g.title, content: g.content });
      } catch (e) {
        return err(e);
      }
    }
  );

  server.registerTool(
    name("get_integration_cards_guidelines"),
    {
      title: "Get UI Integration Cards guidelines",
      description: "Returns best practices for developing SAP UI Integration Cards (manifest-driven cards for SAP Build Work Zone).",
      inputSchema: {},
      outputSchema: guidelinesOutput,
      annotations: READ_LOCAL
    },
    async () => {
      try {
        const g = guidelines.cards;
        return json({ topic: "cards", title: g.title, content: g.content });
      } catch (e) {
        return err(e);
      }
    }
  );

  server.registerTool(
    name("get_typescript_conversion_guidelines"),
    {
      title: "Get UI5 JS→TS conversion guidelines",
      description: "Returns the step-by-step guideline for converting UI5 applications and controllers from JavaScript to TypeScript.",
      inputSchema: {},
      outputSchema: guidelinesOutput,
      annotations: READ_LOCAL
    },
    async () => {
      try {
        const g = guidelines.typescript;
        return json({ topic: "typescript", title: g.title, content: g.content });
      } catch (e) {
        return err(e);
      }
    }
  );
}
