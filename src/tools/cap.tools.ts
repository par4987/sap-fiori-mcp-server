import { z } from "zod";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "../config.js";
import { buildCdsModel, searchModel, getDefinitionDetails, getServiceExposure, resolveEntityCsv } from "../cap/model.js";
import { queryCsv } from "../cap/csv.js";
import { resolvePath, readText, walkFiles, relativePath } from "../util/fs.js";
import { json, err, paginate, READ_LOCAL } from "./index.js";
import { searchModelOutput, capDetailsOutput, queryCapDataOutput } from "./schemas.js";

export function registerCapTools(server: McpServer, config: AppConfig, name: (n: string) => string = (n) => n): void {
  server.registerTool(
    name("search_model"),
    {
      title: "Search the CDS model (CAP)",
      description:
        "Performs fuzzy searches against names of definitions from the compiled CDS model of a CAP project: entities, views (projections), services, types, aspects, events, actions. " +
        "CDS parses all .cds files into a unified model including relationships and annotations. Example: searchModel(projectPath, 'Books', 'entity').",
      inputSchema: {
        projectPath: z.string().optional().describe("CAP project root (default workspace root)"),
        query: z.string().min(1).describe("Fuzzy query, e.g. 'book', 'Orders', 'my.bookshop'"),
        kind: z.enum(["all", "entity", "view", "service", "type", "aspect", "event", "action", "function", "extend"]).default("all").describe("Filter by definition kind"),
        limit: z.number().int().min(1).max(50).default(20).describe("Max results per page"),
        offset: z.number().int().min(0).default(0).describe("Results to skip (use nextOffset from a previous call)")
      },
      outputSchema: searchModelOutput,
      annotations: READ_LOCAL
    },
    async (args) => {
      try {
        const limit = args.limit ?? 20;
        const offset = args.offset ?? 0;
        const model = buildCdsModel(args.projectPath ?? config.workspaceRoot);
        // rank every definition first, so the pagination metadata covers all matches
        const all = searchModel(model, args.query, { kind: args.kind, limit: Number.MAX_SAFE_INTEGER });
        const page = paginate(all, limit, offset);
        return json({
          sourcesParsed: model.sources.length,
          namespaces: model.namespaces,
          totalDefinitions: model.definitions.length,
          count: page.count,
          total: page.total,
          offset: page.offset,
          hasMore: page.hasMore,
          nextOffset: page.nextOffset,
          results: page.items
        });
      } catch (e) {
        return err(e);
      }
    }
  );

  server.registerTool(
    name("get_cap_details"),
    {
      title: "Get details of a CDS definition (CAP)",
      description: "Returns full details of one CDS definition: elements with types and annotations, associations (target, cardinality, on-condition), actions/functions, projections and includes.",
      inputSchema: {
        projectPath: z.string().optional().describe("CAP project root"),
        definitionName: z.string().min(1).describe("Definition name (short or fully qualified), e.g. 'Books' or 'my.bookshop.Books'")
      },
      outputSchema: capDetailsOutput,
      annotations: READ_LOCAL
    },
    async (args) => {
      try {
        const model = buildCdsModel(args.projectPath ?? config.workspaceRoot);
        const details = getDefinitionDetails(model, args.definitionName);
        if (!details) {
          const near = searchModel(model, args.definitionName, { limit: 5 }).map((d) => d.name);
          return err(
            new Error(
              `Definition '${args.definitionName}' not found in the CDS model (${model.definitions.length} definitions from ${model.sources.length} sources).` +
                (near.length ? ` Closest matches: ${near.join(", ")}.` : " Use search_model to list what the project defines.")
            )
          );
        }
        const exposure = getServiceExposure(model).filter((s) =>
          s.exposed.some((x) => x.source === details.name || x.source.split(".").pop() === details.shortName)
        );
        return json({ ...details, exposedByServices: exposure });
      } catch (e) {
        return err(e);
      }
    }
  );

  server.registerTool(
    name("query_cap_data"),
    {
      title: "Query CAP sample data (CSV mock)",
      description:
        "Executes a CQN-like query against the CAP sample data (CSV files in db/data following CAP conventions). " +
        "Supports column projection, a WHERE-like filter (and/or, eq/ne/gt/ge/lt/le, contains), order by, skip/limit. Example filter: 'stock gt 10 and price le 50'.",
      inputSchema: {
        projectPath: z.string().optional().describe("CAP project root"),
        entityName: z.string().min(1).describe("Entity name, e.g. 'Books' or 'my.bookshop.Books'"),
        columns: z.array(z.string()).optional().describe("Columns to project (default all)"),
        filter: z.string().optional().describe("WHERE-like filter, e.g. \"stock > 0 and contains(title, 'Cat')\""),
        orderBy: z.array(z.object({ column: z.string(), desc: z.boolean().optional() })).optional().describe("Sort spec"),
        limit: z.number().int().min(1).max(500).default(50).describe("Max rows"),
        skip: z.number().int().min(0).default(0).describe("Rows to skip")
      },
      outputSchema: queryCapDataOutput,
      annotations: READ_LOCAL
    },
    async (args) => {
      try {
        const root = resolvePath(args.projectPath ?? config.workspaceRoot);
        const csvFile = resolveEntityCsv(root, args.entityName);
        if (!csvFile) {
          const csvs = walkFiles(root, (f) => f.toLowerCase().endsWith(".csv"), 8).map((f) => relativePath(f, root));
          return err(
            new Error(
              `No CSV data file found for entity '${args.entityName}' under ${root}. CSV files found: ${csvs.length ? csvs.join(", ") : "(none)"}. ` +
                "Naming convention: db/data/<namespace>-<Entity>.csv"
            )
          );
        }
        const limit = args.limit ?? 50;
        const skip = args.skip ?? 0;
        const result = queryCsv(readText(csvFile), relativePath(csvFile, root), {
          columns: args.columns,
          filter: args.filter,
          orderBy: args.orderBy,
          limit,
          skip
        });
        const hasMore = skip + result.rows.length < result.count;
        return json({
          file: result.file,
          columns: result.columns,
          rows: result.rows,
          count: result.rows.length,
          total: result.count,
          skip,
          limit,
          hasMore,
          nextSkip: hasMore ? skip + result.rows.length : null
        });
      } catch (e) {
        return err(e);
      }
    }
  );
}
