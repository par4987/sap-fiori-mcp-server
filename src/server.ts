import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "./config.js";
import { SERVER_NAME, SERVER_VERSION } from "./config.js";
import { registerDocTools } from "./tools/doc.tools.js";
import { registerFioriTools } from "./tools/fiori.tools.js";
import { registerUi5Tools } from "./tools/ui5.tools.js";
import { registerCapTools } from "./tools/cap.tools.js";
import { registerBtpTools } from "./tools/btp.tools.js";
import { registerDeployTools } from "./tools/deploy.tools.js";
import { fullCorpus } from "./docs/index.js";

export const SERVER_INSTRUCTIONS = `@pired/sap-fiori-mcp-server unifies three SAP development toolsets plus SAP BTP connectivity:
1. FIORI (inspired by @sap-ux/fiori-mcp-server): generate and modify SAP Fiori elements applications.
   Workflow: search_docs (ground yourself) → list_fiori_apps → generate_fiori_app_odata / generate_fiori_app_cap →
   list_functionality → get_functionality_details → execute_functionality.
   Floorplans: list-report, object-page (form entry), worklist, analytical-list-page (V2), overview-page (V2).
2. UI5 (inspired by @ui5/mcp-server): create_ui5_app (basic, worklist, master-detail, fcl, tabs), create_integration_card,
   get_api_reference, get_guidelines, get_project_info, get_version_info, run_manifest_validation, run_ui5_linter.
3. CAP (inspired by @cap-js/mcp-server): search_model (fuzzy search over .cds definitions), get_cap_details,
   query_cap_data (CSV sample data queries).
4. BTP: list_btp_destinations, get_btp_destination, query_odata_data — call remote OData services (V2/V4) through
   SAP BTP destinations (local env/file/dir or the BTP Destination Service), or via list_sap_systems / plain URLs.
5. DEPLOY: deploy_fiori_app publishes an app that has already been generated — validate → build → upload → verify — on the
   ABAP system it belongs to (on premise or ABAP Environment on BTP), with no confirmation step. After generating an app,
   deploy it: the app is only done when it answers on its own URL. The package defaults to $TMP and, when the system
   refuses it, an accepted package is found or created without asking.
Rules: Always call search_docs/search_model before creating or modifying CDS models or Fiori elements apps.
Provide absolute paths for appPath/projectPath arguments. Data models for Fiori elements need one main entity
plus associations; use UUID primary keys and UUID foreign keys in CSV sample data.
Results: every tool returns structuredContent alongside the JSON text. Search and query tools paginate —
when hasMore is true, call again with the returned nextOffset (search_docs, search_model) or nextSkip
(query_cap_data, query_odata_data) instead of raising the limit.`;

/**
 * Optional tool-name prefix (SAP_FIORI_MCP_TOOL_PREFIX).
 *
 * Tool names live in one flat namespace per client, so a workspace running several SAP MCP
 * servers can end up with two `search_docs`. Setting a prefix renames every tool of this
 * server at once, e.g. `sapfiori_search_docs`.
 */
export function toolNamer(config: AppConfig): (n: string) => string {
  const prefix = config.toolPrefix ? (config.toolPrefix.endsWith("_") ? config.toolPrefix : `${config.toolPrefix}_`) : "";
  return (n: string) => `${prefix}${n}`;
}

/** Build a fresh MCP server instance with all tools registered (also used per-request in HTTP mode). */
export function createMcpServer(config: AppConfig): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: SERVER_INSTRUCTIONS }
  );

  const name = toolNamer(config);
  registerDocTools(server, config, name);
  registerFioriTools(server, config, name);
  registerUi5Tools(server, config, name);
  registerCapTools(server, config, name);
  registerBtpTools(server, config, name);
  registerDeployTools(server, config, name);

  // resource: read bundled docs entries as resources (skipped when noResources)
  if (!config.noResources) {
    for (const doc of fullCorpus) {
      server.registerResource(
        `doc-${doc.id}`,
        `docs://corpus/${doc.corpus}/${doc.id}`,
        { title: doc.title, description: `${doc.corpus}: ${doc.title}` },
        async (uri) => ({ contents: [{ uri: uri.href, text: doc.body, mimeType: "text/markdown" }] })
      );
    }
  }

  return server;
}
