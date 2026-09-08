import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "../config.js";
import {
  loadDestinations,
  redactDestination,
  getDestinationServiceConfig,
  listServiceDestinations,
  findDestination,
  buildAuthHeaders,
  resolveODataTarget
} from "../btp/destinations.js";
import { odataRequest, appendSearchParams, extractRows } from "../odata/client.js";
import { json, err, READ_REMOTE } from "./index.js";
import { listDestinationsOutput, getDestinationOutput, queryODataOutput } from "./schemas.js";

const DESTINATION_HINT =
  "Destinations are loaded from SAP_DESTINATIONS_JSON (inline JSON array), SAP_DESTINATIONS_FILE, " +
  "SAP_DESTINATIONS_DIR (one <name>.json per destination; default ~/.sap-fiori-mcp/destinations) or the BTP Destination Service " +
  "(BTP_CLIENT_ID/BTP_CLIENT_SECRET/BTP_TOKEN_URL/BTP_DESTINATION_API_URL, or a VCAP_SERVICES binding).";

export function registerBtpTools(server: McpServer, config: AppConfig, name: (n: string) => string = (n) => n): void {
  server.registerTool(
    name("list_btp_destinations"),
    {
      title: "List SAP BTP destinations",
      description:
        "Lists the SAP BTP destinations available for OData calls: local destinations (env var SAP_DESTINATIONS_JSON / SAP_DESTINATIONS_FILE / SAP_DESTINATIONS_DIR) " +
        "and, when configured, destinations of the BTP Destination Service (cloud). Secrets are redacted. " +
        "Use the returned destination names with query_odata_data and download_odata_service_metadata.",
      inputSchema: {
        includeDestinationService: z.boolean().default(true).describe("Also fetch destinations from the BTP Destination Service when it is configured (requires network)")
      },
      outputSchema: listDestinationsOutput,
      annotations: READ_REMOTE
    },
    async (args) => {
      try {
        const local = loadDestinations(config).map(redactDestination);
        const result: Record<string, unknown> = {
          count: local.length,
          destinations: local,
          destinationServiceConfigured: !!getDestinationServiceConfig(),
          hint: DESTINATION_HINT
        };
        const svc = args.includeDestinationService !== false ? getDestinationServiceConfig() : null;
        if (svc) {
          try {
            const remote = (await listServiceDestinations(svc, config.requestTimeoutMs)).map(redactDestination);
            const known = new Set(local.map((d) => String(d.name).toLowerCase()));
            result.destinationService = { count: remote.length, destinations: remote.filter((d) => !known.has(String(d.name).toLowerCase())) };
            result.count = local.length + (result.destinationService as { count: number }).count;
          } catch (e) {
            result.destinationServiceError = e instanceof Error ? e.message : String(e);
          }
        }
        return json(result);
      } catch (e) {
        return err(e);
      }
    }
  );

  server.registerTool(
    name("get_btp_destination"),
    {
      title: "Get a SAP BTP destination (secrets redacted)",
      description:
        "Returns the details of one SAP BTP destination (local or from the BTP Destination Service): URL, authentication type, sap-client, custom headers and proxy type. " +
        "Secrets are redacted. Useful to verify a destination before querying it with query_odata_data.",
      inputSchema: {
        name: z.string().min(1).describe("Destination name (see list_btp_destinations)")
      },
      outputSchema: getDestinationOutput,
      annotations: READ_REMOTE
    },
    async (args) => {
      try {
        const d = await findDestination(config, args.name, config.requestTimeoutMs);
        if (!d) {
          const available = loadDestinations(config).map((x) => x.name);
          return err(
            new Error(
              `Destination '${args.name}' not found. Available: ${available.length ? available.join(", ") : "(none)"}. ` +
                (getDestinationServiceConfig() ? "Destination Service is configured; the name may not exist there." : "Destination Service is not configured. " + DESTINATION_HINT)
            )
          );
        }
        const redacted = redactDestination(d);
        let authSummary: Record<string, unknown> = { authType: d.authType };
        try {
          const headers = await buildAuthHeaders(d, config.requestTimeoutMs);
          authSummary = {
            authType: d.authType,
            resolvedHeaders: Object.keys(headers),
            authorization: headers.authorization
              ? headers.authorization.startsWith("Basic ")
                ? "Basic ***"
                : `Bearer ${headers.authorization.slice(7, 12)}…(exchanged)`
              : undefined,
            sapClient: headers["sap-client"]
          };
        } catch (e) {
          authSummary = { authType: d.authType, error: e instanceof Error ? e.message : String(e) };
        }
        return json({
          destination: redacted,
          auth: authSummary,
          usage: {
            queryData: `query_odata_data { destination: "${d.name}", entitySet: "MyEntity", top: 10 }`,
            downloadMetadata: `download_odata_service_metadata { destination: "${d.name}", servicePath: "/sap/opu/odata4/sap/zsrv/srv" }`
          }
        });
      } catch (e) {
        return err(e);
      }
    }
  );

  server.registerTool(
    name("query_odata_data"),
    {
      title: "Query OData data via destination, system or URL",
      description:
        "Executes an OData query (V2 or V4) against an entity set and returns the rows as JSON. " +
        "Target: a BTP destination (destination + optional servicePath), a configured SAP system (systemName + servicePath from list_sap_systems), or a full serviceUrl. " +
        "Supports $filter, $top, $skip, $select, $orderby, $expand and $count. This is the remote counterpart of query_cap_data.",
      inputSchema: {
        entitySet: z.string().describe("Entity set name, e.g. 'Travel' or 'Products'"),
        destination: z.string().optional().describe("BTP destination name (see list_btp_destinations)"),
        systemName: z.string().optional().describe("Configured SAP system name (see list_sap_systems)"),
        servicePath: z.string().optional().describe("Service path relative to the destination/system URL, e.g. /sap/opu/odata4/sap/zui_travel_ov4/srv"),
        serviceUrl: z.string().optional().describe("Full service URL (used when no destination/system is given)"),
        filter: z.string().optional().describe("OData $filter, e.g. \"Status eq 'A' and Price gt 100\""),
        top: z.number().int().min(1).max(1000).optional().describe("$top (max rows returned by the service, default 50)"),
        skip: z.number().int().min(0).optional().describe("$skip"),
        select: z.string().optional().describe("$select comma-separated fields"),
        orderBy: z.string().optional().describe("$orderby, e.g. 'CreatedAt desc'"),
        expand: z.string().optional().describe("$expand navigation properties, e.g. '_Travel,_Agency'"),
        count: z.boolean().optional().describe("Ask the service for the total number of rows"),
        odataVersion: z
          .enum(["2.0", "4.0"])
          .optional()
          .describe(
            "Service OData version. Only affects how the total is requested: $count=true in V4, $inlinecount=allpages in V2. " +
              "When omitted, V4 is tried first and V2 is retried automatically if the service rejects it."
          ),
        maxRows: z.number().int().min(1).max(500).default(100).describe("Max rows included in the tool output (safety limit)")
      },
      outputSchema: queryODataOutput,
      annotations: READ_REMOTE
    },
    async (args) => {
      try {
        const target = await resolveODataTarget(
          config,
          { destination: args.destination, systemName: args.systemName, serviceUrl: args.serviceUrl, servicePath: args.servicePath },
          config.requestTimeoutMs
        );
        const base = target.url.replace(/\/$/, "");
        // V2 and V4 ask for the row total with different query options: $count is not a query
        // option at all in V2 (there it is a path segment), and services reject it outright.
        const countParams = (version: "2.0" | "4.0") =>
          !args.count ? {} : version === "2.0" ? { $inlinecount: "allpages" } : { $count: "true" };
        const buildUrl = (version: "2.0" | "4.0") =>
          appendSearchParams(`${base}/${args.entitySet.replace(/^\//, "")}`, {
            $filter: args.filter,
            $top: args.top !== undefined ? String(args.top) : args.count ? undefined : "50",
            $skip: args.skip !== undefined ? String(args.skip) : undefined,
            $select: args.select,
            $orderby: args.orderBy,
            $expand: args.expand,
            ...countParams(version),
            $format: "json"
          });

        const request = (u: string) =>
          odataRequest({ url: u, system: target.system, headers: target.headers, timeoutMs: config.requestTimeoutMs, config, trustedUrls: target.trustedUrls });

        let version: "2.0" | "4.0" = args.odataVersion ?? "4.0";
        let url = buildUrl(version);
        let res = await request(url);
        // the caller usually does not know the version; recover instead of failing on a V2 service
        if (!res.ok && res.status === 400 && args.count && !args.odataVersion && /\$count/.test(res.text)) {
          version = "2.0";
          url = buildUrl(version);
          res = await request(url);
        }
        if (!res.ok) {
          return json(
            {
              appliedUrl: url,
              source: target.source,
              status: res.status,
              error: `HTTP ${res.status}`,
              body: res.text.slice(0, 2000),
              hint:
                res.status === 400 && args.count
                  ? "The service rejected the query. If it is OData V2, pass odataVersion:'2.0' so the total is requested as $inlinecount=allpages."
                  : undefined
            },
            true
          );
        }
        const { rows, inlineCount } = extractRows(res.json);
        const maxRows = args.maxRows ?? 100;
        const returned = rows.slice(0, maxRows);
        const skip = args.skip ?? 0;
        // more rows exist when the service filled the page, or when $count says so
        const hasMore = rows.length > returned.length || (inlineCount !== undefined && skip + returned.length < inlineCount);
        return json({
          source: target.source,
          appliedUrl: url,
          count: returned.length,
          rowCount: returned.length, // deprecated alias of `count`, kept for compatibility
          odataVersion: version,
          total: inlineCount,
          inlineCount,
          truncatedTo: rows.length > maxRows ? maxRows : undefined,
          hasMore,
          nextSkip: hasMore ? skip + returned.length : null,
          rows: returned,
          destination: target.destination
        });
      } catch (e) {
        return err(e);
      }
    }
  );
}
