# @pired/sap-fiori-mcp-server

**A unified Model Context Protocol (MCP) server for SAP Fiori development — built from scratch in TypeScript with no SAP dependencies.**

One binary that combines the capabilities of the three reference MCP servers of the SAP ecosystem, **plus SAP BTP connectivity**:

| Inspired by | Replicated capabilities |
|---|---|
| [`@sap-ux/fiori-mcp-server`](https://github.com/SAP/open-ux-tools/tree/main/packages/fiori-mcp-server) | Fiori elements app generation & modification, documentation search, OData metadata download |
| [`@ui5/mcp-server`](https://github.com/UI5/mcp-server) | UI5 scaffolding, integration cards, API reference, guidelines, manifest validation, linter |
| [`@cap-js/mcp-server`](https://github.com/cap-js/mcp-server) | Fuzzy search over the CDS model, definition details, sample-data queries |
| ➕ **SAP BTP** | Local destinations and the **BTP Destination Service**, remote OData V2/V4 queries (`query_odata_data`) |

> 📖 Documentación en español: [README.md](./README.md)

## Features

- **26 MCP tools** for Claude Desktop, Claude Code, Cursor, VS Code (Copilot), Cline, Windsurf or any MCP client.
- **SAP BTP support**: destinations from env vars, files or the cloud **Destination Service** (automatic OAuth2, secrets always redacted).
- **5 Fiori elements floorplans**: `list-report`, `object-page` (form entry), `worklist`, `analytical-list-page` (V2) and `overview-page` (V2).
- **Dual transport**: `stdio` (default) and **HTTP Streamable** (`--http --port 3001`) with optional API key.
- **No SAP dependencies**: CDS parser, EDMX parser, OData V2/V4 client and a CSV query engine written from scratch (runtime deps: MCP SDK + zod only).
- **Bundled documentation**: local corpus for Fiori Elements, UI5, CAP, OPA5 and BTP destinations with TF-IDF search — works offline.
- **Structured output**: every tool declares an `outputSchema` and returns `structuredContent` next to the JSON text block, plus behaviour annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`).
- **Explicit pagination** on the search and query tools: `count`, `total`, `hasMore` and `nextOffset`/`nextSkip`.
- **Security by design**: credentials only via environment variables, redacted secrets in tool output, API key and `Origin` validation (DNS-rebinding protection) in HTTP mode, optional outbound host allowlist, never logs to stdout.

## Installation

```bash
# Direct usage with npx (once published to npm):
npx @pired/sap-fiori-mcp-server

# Global install:
npm install -g @pired/sap-fiori-mcp-server
sap-fiori-mcp --http --port 3001

# From the tarball without publishing:
npm install -g pired-sap-fiori-mcp-server-1.1.0.tgz

# From source:
npm install && npm run build
```

> npm publishing guide: [`docs/NPM-PUBLISH.md`](./docs/NPM-PUBLISH.md).

## Quick start

```bash
git clone <this-repo> && cd sap-fiori-mcp-server
npm install && npm run build
npm test              # 148 unit + integration tests
npm start             # stdio mode
npm run start:http    # HTTP mode on http://localhost:3001/mcp
```

### MCP client configuration

**Claude Code**
```bash
# Once published to npm, the simplest way:
claude mcp add sap-fiori-mcp -- npx -y @pired/sap-fiori-mcp-server

# Or pointing to a local copy of the code:
claude mcp add sap-fiori-mcp -- node /abs/path/sap-fiori-mcp-server/dist/index.js
```

**Claude Desktop / Cursor / Cline (`mcpServers`)**
```json
{
  "mcpServers": {
    "sap-fiori-mcp": {
      "type": "stdio",
      "command": "node",
      "args": ["/abs/path/sap-fiori-mcp-server/dist/index.js"],
      "env": {
        "SAP_BASE_URL": "https://your-system:44300",
        "SAP_CLIENT": "100",
        "SAP_USER": "DEVELOPER",
        "SAP_PASSWORD": "secret"
      }
    }
  }
}
```

**VS Code `.vscode/mcp.json`** — same server object under `"servers"` with `"type": "stdio"`.

**HTTP mode**
```bash
SAP_FIORI_MCP_API_KEY=secret node dist/index.js --http --port 3001 --host 0.0.0.0
```
```json
{ "mcpServers": { "sap-fiori-mcp": { "type": "streamableHttp", "url": "http://host:3001/mcp", "headers": { "x-api-key": "secret" } } } }
```

Endpoints: `POST /mcp` (MCP Streamable HTTP) and `GET /health`.

> The server validates the `Origin` header. Requests without one (MCP clients, curl, IDE extensions)
> and loopback origins are accepted; any other browser origin gets a 403 unless listed in
> `SAP_FIORI_MCP_ALLOWED_ORIGINS`. Always set `SAP_FIORI_MCP_API_KEY` when binding to `0.0.0.0`.

**Docker**
```bash
docker build -t sap-fiori-mcp-server .
docker run -p 3001:3001 -e SAP_FIORI_MCP_API_KEY=secret sap-fiori-mcp-server --http --port 3001 --host 0.0.0.0
docker run -i --rm sap-fiori-mcp-server   # stdio
```

## Available tools (26)

**Docs & guidelines**: `search_docs` (scopes: fiori/ui5/cap/opa5/cards/typescript/btp), `get_guidelines`, `get_integration_cards_guidelines`, `get_typescript_conversion_guidelines`

**Fiori**: `list_fiori_apps`, `list_sap_systems`, `download_odata_service_metadata` (via `serviceUrl`, `systemName` or BTP `destination`), `get_metadata_summary`, `generate_fiori_app_odata` (floorplans: list-report, object-page, worklist, analytical-list-page, overview-page), `generate_fiori_app_cap`, plus the 3-step modification workflow `list_functionality` → `get_functionality_details` → `execute_functionality` (`add_page`, `delete_page`, `add_controller_extension`, `enable_fcl`, `enable_initial_load`, `update_manifest`)

**UI5**: `create_ui5_app` (basic/worklist/master-detail/fcl/tabs), `create_integration_card` (8 card types), `get_api_reference` (official TS type definitions via CDN, cached), `get_project_info`, `get_version_info`, `run_manifest_validation`, `run_ui5_linter`

**CAP**: `search_model` (fuzzy over parsed .cds definitions), `get_cap_details` (elements, keys, associations, actions, annotations, service exposure), `query_cap_data` (CQN-like queries over `db/data/*.csv`: columns, and/or filters, eq/ne/gt/ge/lt/le, contains, order, skip/limit)

**SAP BTP**: `list_btp_destinations` (local + Destination Service, redacted), `get_btp_destination` (details + resolved auth preview), `query_odata_data` (remote OData V2/V4 queries with $filter/$top/$skip/$select/$orderby/$expand/$count via destination, system or URL)

## Connection admin panel

```bash
npx @pired/sap-fiori-mcp-server --admin
```

A local panel to create, edit, rename and delete SAP systems and BTP destinations, and to **test
each connection**: host reachability, credential acceptance and `$metadata` readability, showing
the HTTP status, the answering `sap-system`, the realm and the actual SAP message. It also reports
whether the TLS certificate is trusted and which `${env:...}` variables are unset.

It binds to `127.0.0.1` only, requires a token minted at each launch and sent as a header, sets no
cookies (removing CSRF rather than mitigating it), and refuses any request whose `Host` is not the
loopback — which is what closes DNS rebinding from the operator's own browser. No secret crosses
the boundary: a password is accepted only as `${env:NAME}`, and secrets already literal in a
destination file are preserved on write but never returned.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `LOG_LEVEL` | `error` | `off`/`error`/`warn`/`info`/`debug` (file log, never stdout) |
| `SAP_FIORI_MCP_LOG_FILE` | `~/.sap-fiori-mcp/server.log` | Log file path |
| `SAP_FIORI_MCP_WORKSPACE_ROOT` | cwd | Default root for relative paths |
| `SAP_BASE_URL`, `SAP_USER`, `SAP_PASSWORD`, `SAP_CLIENT`, `SAP_SYSTEM_NAME` | — | "default" SAP system with Basic Auth |
| `SAP_SYSTEMS_JSON` / `SAP_SYSTEMS_FILE` | `~/.sap-fiori-mcp/systems.json` | Multiple systems: `[{ "name", "url", "client", "user", "password" }]` |
| `SAP_DESTINATIONS_JSON` | — | Inline BTP destinations: `[{ "Name", "URL", "Authentication", ... }]` (also accepts the Cloud SDK `destinations` env var) |
| `SAP_DESTINATIONS_FILE` / `SAP_DESTINATIONS_DIR` | dir: `~/.sap-fiori-mcp/destinations` | One JSON per destination (`<name>.json`, cockpit export or camelCase format) |
| `BTP_CLIENT_ID` / `BTP_CLIENT_SECRET` / `BTP_TOKEN_URL` / `BTP_DESTINATION_API_URL` | — | Connection to the **BTP Destination Service** (or automatic detection via `VCAP_SERVICES`) |
| `BTP_USER_TOKEN` | — | User token for `OAuth2UserTokenExchange` / `OAuth2JWTBearer` destinations |
| `UI5_DISTRIBUTION` | `openui5` | `openui5` or `sapui5` |
| `UI5_CDN_URL` | per distribution | Alternative UI5 CDN |
| `UI5_TYPES_CDN_URL` | jsDelivr `@openui5/ts-types-esm` | Source of type definitions for `get_api_reference` |
| `SAP_FIORI_MCP_API_KEY` | — | Required API key in HTTP mode |
| `SAP_FIORI_MCP_ALLOWED_DOMAINS` | *(empty = unrestricted)* | Outbound host allowlist. Restricts URLs passed as tool arguments (`serviceUrl`); hosts of configured systems, destinations and CDNs are always allowed. Supports `*.domain.com` |
| `SAP_FIORI_MCP_ALLOWED_ORIGINS` | *(loopback only)* | HTTP mode: accepted browser origins. `*` disables the check |
| `SAP_FIORI_MCP_TOOL_PREFIX` | — | Prefixes every tool name (e.g. `sapfiori_search_docs`) to avoid clashes with other MCP servers |
| `SAP_FIORI_MCP_TIMEOUT_MS` | `30000` | OData/CDN request timeout |
| `SAP_FIORI_MCP_RESPONSE_NO_RESOURCES` | — | Disable MCP resources for limited clients |

Self-signed certificates: set `NODE_EXTRA_CA_CERTS=/path/ca.crt` (recommended) or `NODE_TLS_REJECT_UNAUTHORIZED=0` (dev only, not recommended).

## SAP BTP connectivity

1. **Local destinations** — one JSON file per destination in `~/.sap-fiori-mcp/destinations/` (or `SAP_DESTINATIONS_JSON` inline). Cockpit export format (`Name`, `URL`, `Authentication`, `User`, `Password`, `sap-client`) or camelCase. OAuth2 destinations exchange tokens automatically per request.
2. **BTP Destination Service** — set `BTP_CLIENT_ID`, `BTP_CLIENT_SECRET`, `BTP_TOKEN_URL`, `BTP_DESTINATION_API_URL` (or provide `VCAP_SERVICES` with `destination` + `xsuaa` bindings). Pre-exchanged `authTokens` returned by the service are applied verbatim, so OAuth2/On-Premise destinations work without exposing secrets.
3. **Typical AI flow** — `list_btp_destinations` → `get_btp_destination` (verify auth) → `query_odata_data` (validate data) → `download_odata_service_metadata` → `generate_fiori_app_odata`.

Secrets (passwords, client secrets, tokens) **never** appear in tool responses.

## AI rules

Copy the rules from [`docs/AGENTS-rules.md`](./docs/AGENTS-rules.md) into your `AGENTS.md`/`CLAUDE.md`/`.cursorrules` so the assistant uses the server correctly — the same pattern the official SAP servers recommend.

## Differences vs. the official servers

| Aspect | Official servers | This server |
|---|---|---|
| Docs search | Local embedding model (~86 MB download) | TF-IDF over bundled corpus, no downloads |
| CDS model | Compiled with `@cap-js/cds` | Own CDS parser (entities, services, aspects, annotations) |
| UI5 API reference | `@ui5/dts-tooling` + CDN | Official TS type definitions via CDN with local cache |
| Transport | stdio | stdio + HTTP Streamable with API key |
| BTP | — | Local destinations + Destination Service + `query_odata_data` |
| Install | `npx` (npm download) | `npx @pired/sap-fiori-mcp-server`, local build or Docker |
| Extras | — | `get_metadata_summary`, `get_cap_details`, `query_cap_data`, demo project |

## Development

```bash
npm run build       # tsc → dist/
npm run typecheck   # tsc --noEmit
npm test            # vitest run (148 tests)
```

**Server evaluation**: [`eval/evaluation.xml`](./eval/evaluation.xml) holds 10 read-only questions
that measure whether a model can solve real tasks with these tools alone (see
[`eval/README.md`](./eval/README.md)). `npm test -- evaluation-answers` re-derives every answer
through the tools so the evaluation cannot go stale when the example project changes.

Debug in VS Code with the ready-made `.vscode/launch.json` configurations. The bundled `examples/bookshop` CAP project lets you try `search_model`, `query_cap_data` and `generate_fiori_app_cap` immediately.

## License

MIT — see [LICENSE](./LICENSE).
