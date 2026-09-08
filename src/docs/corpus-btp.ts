import type { DocEntry } from "../util/search.js";

/**
 * SAP BTP destinations and connectivity documentation corpus (English).
 * Served by the `search_docs` tool with scope "btp".
 */
export const btpDocs: DocEntry[] = [
  {
    id: "btp-destinations-overview",
    corpus: "btp",
    title: "SAP BTP destinations for OData connectivity",
    tags: ["destination", "btp", "connectivity", "odata", "auth"],
    body: `A SAP BTP destination bundles the connection details of a remote system (URL, authentication, proxy type) so that apps can call it by name. sap-fiori-mcp-server resolves destinations with list_btp_destinations / get_btp_destination and uses them in download_odata_service_metadata (destination + servicePath) and query_odata_data (destination + entitySet). Local destinations are loaded from: 1) the SAP_DESTINATIONS_JSON env var containing a JSON array of destinations, 2) the SAP_DESTINATIONS_FILE env var pointing to one JSON file (array or { destinations: [...] }), 3) the SAP_DESTINATIONS_DIR folder with one <name>.json file per destination (default ~/.sap-fiori-mcp/destinations), and also the Cloud SDK style lowercase 'destinations' env var. Supported authentication types: NoAuthentication, BasicAuthentication, OAuth2ClientCredentials, OAuth2UserTokenExchange, OAuth2JWTBearer; ClientCertificateAuthentication and SAMLAssertion require the BTP Destination Service. Secrets (password, clientSecret, tokens) are always redacted in tool output.`
  },
  {
    id: "btp-destination-formats",
    corpus: "btp",
    title: "Destination file formats (cockpit export and camelCase)",
    tags: ["destination", "json", "format", "example", "BasicAuthentication", "OAuth2ClientCredentials"],
    body: `Destinations accept the SAP cockpit export format (Title case) or camelCase. Cockpit format example: { "Name": "S4H", "URL": "https://s4.example.com:44300", "Authentication": "BasicAuthentication", "User": "dev", "Password": "secret", "sap-client": "100", "ProxyType": "Internet", "WebIDEEnabled": "true" }. OAuth2ClientCredentials example: { "name": "SFSF", "url": "https://apiXX.successfactors.com", "authType": "OAuth2ClientCredentials", "clientId": "sb-...", "clientSecret": "...", "tokenServiceUrl": "https://xxx.authentication.eu10.hana.ondemand.com/oauth/token" }. Fields understood: Name/name, URL/url, Authentication/authType, User/user/username, Password/password, sap-client/client, clientId, clientSecret, tokenServiceURL, tokenServiceUser/tokenServicePassword, ProxyType, and headers (custom HTTP headers applied to every request). For OAuth2UserTokenExchange/OAuth2JWTBearer set 'userToken' (or the BTP_USER_TOKEN env var). The XSUAA token is exchanged automatically per request (grant_type client_credentials).`
  },
  {
    id: "btp-destination-service",
    corpus: "btp",
    title: "BTP Destination Service (cloud) integration",
    tags: ["destination service", "VCAP_SERVICES", "xsuaa", "destination-configuration", "cloud"],
    body: `When the MCP server runs on SAP BTP (Cloud Foundry/Kyma) or has service keys, it can read destinations from the BTP Destination Service REST API. Configuration (env vars): BTP_CLIENT_ID, BTP_CLIENT_SECRET, BTP_TOKEN_URL (XSUAA) and BTP_DESTINATION_API_URL (e.g. https://destination-configuration.cfapps.eu10.hana.ondemand.com). Alternatively provide a VCAP_SERVICES env var containing a 'destination' service binding (credentials.uri) plus an 'xsuaa' binding (url, clientid, clientsecret) — the binding is detected automatically. Flow: POST {tokenUrl}/oauth/token?grant_type=client_credentials (Basic auth) → GET {apiUrl}/destination-configuration/v1/destinations/{name} (instance level) then /v1/subaccountDestinations/{name} (subaccount level); GET /destination-configuration/v1/destinations and /v1/subaccountDestinations list destinations. When the service returns pre-exchanged authTokens, they are applied verbatim as the Authorization header (so OAuth2ClientCredentials/OnPremise destinations work without exposing secrets).`
  },
  {
    id: "btp-odata-query",
    corpus: "btp",
    title: "Querying OData data remotely (query_odata_data)",
    tags: ["query_odata_data", "odata", "filter", "top", "expand", "v2", "v4"],
    body: `query_odata_data executes an OData query against an entity set and returns JSON rows; it is the remote counterpart of query_cap_data. Target selection priority: destination (BTP destination name, optional servicePath) → systemName + servicePath (list_sap_systems) → serviceUrl (full URL). System query options: $filter (e.g. "Status eq 'A' and Price gt 100"), $top (default 50), $skip, $select, $orderby (e.g. "CreatedAt desc"), $expand (e.g. "_Travel,_Agency") and $count=true for the total. Works with OData V2 (d/results) and V4 (value) responses — rows are normalized and inlineCount returned when available. Output is capped by maxRows (default 100) to protect the model context. Typical flow: list_btp_destinations → get_btp_destination (verify auth resolves) → query_odata_data → download_odata_service_metadata → generate_fiori_app_odata.`
  }
];
