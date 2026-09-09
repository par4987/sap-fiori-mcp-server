import { z } from "zod";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "../config.js";
import { listFioriApps } from "../fiori/apps.js";
import { buildCdsModel, getServiceExposure } from "../cap/model.js";
import { generateFioriApp } from "../fiori/generate.js";
import { listFunctionalities, getFunctionalityDetails, executeFunctionality } from "../fiori/functionality.js";
import { resolvePath, readText, writeFileSafe, relativePaths } from "../util/fs.js";
import { resolveSystem, fetchServiceMetadata } from "../odata/client.js";
import { resolveODataTarget } from "../btp/destinations.js";
import { parseEdmx } from "../odata/edmx.js";
import { json, err, READ_LOCAL, WRITE_CREATE, WRITE_MODIFY, WRITE_REMOTE } from "./index.js";
import {
  listFioriAppsOutput,
  listSapSystemsOutput,
  metadataOutput,
  generateAppOutput,
  listFunctionalityOutput,
  functionalityDetailsOutput,
  executeFunctionalityOutput
} from "./schemas.js";

export const FLOORPLANS_V4 = ["list-report", "object-page", "worklist"] as const;
export const FLOORPLANS_ALL = ["list-report", "object-page", "worklist", "analytical-list-page", "overview-page"] as const;
export type Floorplan = (typeof FLOORPLANS_ALL)[number];

export function registerFioriTools(server: McpServer, config: AppConfig, name: (n: string) => string = (n) => n): void {
  server.registerTool(
    name("list_fiori_apps"),
    {
      title: "List Fiori apps in a workspace",
      description:
        "Scans a directory for existing SAP Fiori applications (Fiori elements V2/V4, freestyle, cards, adaptation projects) that can be modified. " +
        "Returns app id, type, entity set, OData version and view files. Call this before modifying an app.",
      inputSchema: {
        workspacePath: z.string().optional().describe("Root folder to scan (default: workspace root / cwd)"),
        maxDepth: z.number().int().min(1).max(10).default(6).describe("Folder recursion depth")
      },
      outputSchema: listFioriAppsOutput,
      annotations: READ_LOCAL
    },
    async (args) => {
      try {
        const project = listFioriApps(args.workspacePath ?? config.workspaceRoot, args.maxDepth);
        return json(project);
      } catch (e) {
        return err(e);
      }
    }
  );

  server.registerTool(
    name("list_sap_systems"),
    {
      title: "List configured SAP systems",
      description:
        "Lists SAP system connections available for OData calls (from env vars SAP_BASE_URL/SAP_USER/SAP_PASSWORD, SAP_SYSTEMS_JSON or the systems.json file). " +
        "Use the returned system name with download_odata_service_metadata.",
      inputSchema: {},
      outputSchema: listSapSystemsOutput,
      annotations: READ_LOCAL
    },
    async () => {
      try {
        const systems = config.sapSystems.map((s) => ({
          name: s.name,
          url: s.url,
          client: s.client,
          authType: s.user ? "basic" : "none",
          user: s.user
        }));
        return json({
          count: systems.length,
          systems,
          // a malformed config file used to be indistinguishable from having none
          ...(config.configWarnings.length ? { warnings: config.configWarnings } : {}),
          hint:
            systems.length === 0
              ? config.configWarnings.length
                ? "A configuration file was found but could not be used; see warnings. Files written on Windows must be UTF-8 and hold a JSON array."
                : "No systems configured. Set env vars SAP_BASE_URL, SAP_USER, SAP_PASSWORD (optionally SAP_CLIENT, SAP_SYSTEM_NAME) or create ~/.sap-fiori-mcp/systems.json with [{ name, url, client, user, password }]."
              : "Use these names as systemName in download_odata_service_metadata and query_odata_data."
        });
      } catch (e) {
        return err(e);
      }
    }
  );

  server.registerTool(
    name("download_odata_service_metadata"),
    {
      title: "Download OData service metadata (EDMX)",
      description:
        "Downloads the $metadata EDMX document of an OData service (V2 or V4) and saves it as localService/metadata.xml (or a custom path). " +
        "Provide serviceUrl directly, or a systemName from list_sap_systems plus servicePath, or a BTP destination (destination + optional servicePath). " +
        "Returns a summary of entity sets and types.",
      inputSchema: {
        serviceUrl: z.string().optional().describe("Full OData service URL, e.g. https://host:port/sap/opu/odata4/sap/my_v4_service?sap-client=000"),
        systemName: z.string().optional().describe("Name of a configured SAP system (see list_sap_systems)"),
        destination: z.string().optional().describe("BTP destination name (see list_btp_destinations) — auth headers are applied automatically"),
        servicePath: z.string().optional().describe("Service path relative to the system/destination URL, e.g. /sap/opu/odata/sap/SEPMRA_PROD_MAN"),
        savePath: z.string().optional().describe("Where to save metadata.xml (default: <workspace>/metadata.xml)")
      },
      outputSchema: metadataOutput,
      annotations: WRITE_REMOTE
    },
    async (args) => {
      try {
        let xml = "";
        let model: ReturnType<typeof parseEdmx>;
        let sourceUrl = "";
        if (args.destination) {
          const target = await resolveODataTarget(config, { destination: args.destination, servicePath: args.servicePath, serviceUrl: args.serviceUrl }, config.requestTimeoutMs);
          const fetched = await fetchServiceMetadata(target.url, undefined, config.requestTimeoutMs, target.headers, config, target.trustedUrls);
          xml = fetched.xml;
          model = fetched.model;
          sourceUrl = fetched.sourceUrl;
        } else {
          const system = args.systemName ? resolveSystem(config, args.systemName) : undefined;
          let url = args.serviceUrl ?? "";
          if (!url && system && args.servicePath) {
            url = system.url.replace(/\/$/, "") + "/" + args.servicePath.replace(/^\//, "");
          }
          if (!url && !system) {
            return err(new Error("Provide either serviceUrl, systemName (+servicePath), or destination (+servicePath). Run list_btp_destinations / list_sap_systems first."));
          }
          const fetched = await fetchServiceMetadata(url, system, config.requestTimeoutMs, undefined, config);
          xml = fetched.xml;
          model = fetched.model;
          sourceUrl = fetched.sourceUrl;
        }
        const saveTarget = resolvePath(args.savePath ?? path.join(config.workspaceRoot, "metadata.xml"));
        writeFileSafe(saveTarget, xml);
        return json({
          savedTo: saveTarget,
          sourceUrl,
          odataVersion: model.version,
          namespaces: model.namespaces,
          entitySets: model.entitySets.map((es) => ({ name: es.name, entityType: es.entityType, navigations: es.navigations })),
          entityTypes: model.entityTypes.map((et) => ({ name: et.name, keys: et.keys, properties: et.properties.length, navigationProperties: et.navigationProperties.map((n) => n.name) })),
          annotationTargets: model.annotations.slice(0, 20).map((a) => a.target)
        });
      } catch (e) {
        return err(e);
      }
    }
  );

  const generateCommon = {
    appName: z.string().describe("App name, used as folder name (e.g. 'travels')"),
    title: z.string().describe("Application title shown in the shell"),
    description: z.string().optional().describe("Application description"),
    namespace: z.string().optional().describe("App id namespace (default 'ns' for OData / 'cap.app' for CAP)"),
    entitySet: z.string().optional().describe("Main entity set (optional if metadata is provided)"),
    addFcl: z.boolean().optional().describe("Enable Flexible Column Layout (default true for V4)"),
    initialLoad: z.boolean().optional().describe("Set initialLoad:true so the List Report table loads without pressing Go (default true for 'worklist')")
  };

  const floorplanAllSchema = z
    .enum(FLOORPLANS_ALL)
    .default("list-report")
    .describe(
      "Floorplan: 'list-report' (LR+ObjectPage, V4+V2), 'object-page' (form entry, V4), 'worklist' (task list, V4+V2), " +
        "'analytical-list-page' (V2) or 'overview-page' (V2). Unsupported combos are auto-adjusted with a warning."
    );

  server.registerTool(
    name("generate_fiori_app_odata"),
    {
      title: "Generate a Fiori elements app for an OData service (non-CAP)",
      description:
        "Generates a new SAP Fiori elements application for an OData V2/V4 service, e.g. from RAP. " +
        "Floorplans: 'list-report' (LR+ObjectPage, V4+V2), 'object-page' (form entry, V4), 'worklist' (V4+V2), 'analytical-list-page' (V2), 'overview-page' (V2). " +
        "Provide metadataXmlPath (from download_odata_service_metadata) or metadataXml content, or just entitySet. Creates manifest.json, Component.js, index.html, i18n, ui5.yaml and package.json.",
      inputSchema: {
        workspacePath: z.string().optional().describe("Target workspace root; app is created as <workspace>/<appName>/"),
        metadataXmlPath: z.string().optional().describe("Path to a local metadata.xml"),
        serviceUrl: z.string().optional().describe("OData service URL to store in the manifest dataSources"),
        odataVersion: z.enum(["2.0", "4.0"]).optional().describe("Force OData version (auto-detected from metadata)"),
        floorplan: floorplanAllSchema,
        ...generateCommon
      },
      outputSchema: generateAppOutput,
      annotations: WRITE_CREATE
    },
    async (args) => {
      try {
        const result = await generateFioriApp({
          targetPath: args.workspacePath ?? config.workspaceRoot,
          appName: args.appName,
          title: args.title,
          description: args.description,
          namespace: args.namespace,
          entitySet: args.entitySet,
          metadataXmlPath: args.metadataXmlPath ? resolvePath(args.metadataXmlPath) : undefined,
          serviceUrl: args.serviceUrl,
          odataVersion: args.odataVersion,
          floorplan: args.floorplan,
          addFcl: args.addFcl ?? true,
          initialLoad: args.initialLoad,
          isCap: false
        });
        return json({
          appPath: result.appPath,
          createdFiles: relativePaths(result.files, args.workspacePath ?? config.workspaceRoot),
          warnings: result.warnings,
          nextSteps: [
            "Adjust sap.app/dataSources/mainService/uri in webapp/manifest.json to your real service URL.",
            "Run `npm install` in the app folder (installs @ui5/cli), then `npm start` (ui5 serve).",
            "Preview with ui5 serve + proxy middleware pointing to your SAP system.",
            "Use execute_functionality to add pages, controller extensions, FCL or initial load."
          ]
        });
      } catch (e) {
        return err(e);
      }
    }
  );

  server.registerTool(
    name("generate_fiori_app_cap"),
    {
      title: "Generate a Fiori elements app inside a CAP project",
      description:
        "Generates a new SAP Fiori elements application inside an existing SAP CAP project (app/ folder), based on an entity of the project's CDS model. " +
        "Reads the CDS model to resolve the main entity and its to-many associations, and wires the app to the CAP service.",
      inputSchema: {
        capProjectPath: z.string().describe("Root of the CAP project (contains package.json with @sap/cds and db/srv folders)"),
        serviceName: z.string().optional().describe("CDS service whose entity is exposed (e.g. CatalogService). Auto-detected when omitted."),
        floorplan: z
          .enum(FLOORPLANS_V4)
          .default("list-report")
          .describe("Floorplan: 'list-report' (LR+ObjectPage), 'object-page' (form entry) or 'worklist'. CAP apps are OData V4."),
        ...generateCommon
      },
      outputSchema: generateAppOutput,
      annotations: WRITE_CREATE
    },
    async (args) => {
      try {
        const root = resolvePath(args.capProjectPath);
        const model = buildCdsModel(root);
        const exposures = getServiceExposure(model);
        let serviceName = args.serviceName;
        let entitySet = args.entitySet;
        let serviceUri = "";
        const warnings: string[] = [];

        if (!exposures.length) {
          warnings.push("No services found in the CDS model; add a service in srv/ first (e.g. 'service CatalogService { entity Books as projection on my.Books; }').");
        }
        if (!serviceName && exposures.length) serviceName = exposures[0].service;
        const exposure = exposures.find((e) => e.service.toLowerCase() === (serviceName ?? "").toLowerCase());
        if (exposure) {
          const svcDef = model.definitions.find((d) => d.name === exposure.service);
          const pathAnno = svcDef?.annotations["path"];
          const nsGuess = svcDef?.namespace ?? exposure.service;
          serviceUri = pathAnno ? `/odata/v4/${pathAnno.replace(/^\//, "")}/` : `/odata/v4/${nsGuess.split(".").pop()}/${exposure.service.split(".").pop()}/`;
          if (!entitySet && exposure.exposed.length) entitySet = exposure.exposed[0].name;
        }
        if (!entitySet) {
          warnings.push("Could not resolve an entity from the CDS model; using placeholder 'Main'. Adjust the manifest after generation.");
          entitySet = "Main";
        }

        const result = await generateFioriApp({
          targetPath: root,
          appName: args.appName,
          title: args.title,
          description: args.description,
          namespace: args.namespace ?? "cap.app",
          entitySet,
          serviceUrl: serviceUri || "/odata/v4/catalog/",
          odataVersion: "4.0",
          floorplan: args.floorplan,
          addFcl: args.addFcl ?? true,
          initialLoad: args.initialLoad,
          isCap: true
        });
        return json({
          appPath: result.appPath,
          resolvedService: serviceName ?? null,
          resolvedEntitySet: entitySet,
          serviceUri,
          createdFiles: relativePaths(result.files, root),
          warnings: [...warnings, ...result.warnings],
          nextSteps: [
            `Run \`cds watch\` in ${root} and open http://localhost:4004 (CAP serves the app/ folder automatically).`,
            `Preview URL: http://localhost:4004/${args.appName}/webapp/index.html`,
            "Adjust serviceUri in the manifest if your service uses a custom @(path:'/...') annotation.",
            "Use search_model to inspect further entities and query_cap_data to check sample data."
          ]
        });
      } catch (e) {
        return err(e);
      }
    }
  );

  server.registerTool(
    name("list_functionality"),
    {
      title: "List modification functionalities for a Fiori app (step 1/3)",
      description:
        "Gets the list of supported modification functionalities for an existing SAP Fiori application: add_page, delete_page, add_controller_extension, enable_fcl, enable_initial_load, update_manifest. " +
        "Workflow: list_functionality → get_functionality_details → execute_functionality.",
      inputSchema: {
        appPath: z.string().min(1).describe("Absolute path to the app folder (containing webapp/manifest.json)")
      },
      outputSchema: listFunctionalityOutput,
      annotations: READ_LOCAL
    },
    async (args) => {
      try {
        const app = listFioriApps(args.appPath, 1);
        if (!app.apps.length) {
          return err(new Error(`No Fiori app found under ${args.appPath}`));
        }
        return json({ app: app.apps[0], functionalities: listFunctionalities(args.appPath) });
      } catch (e) {
        return err(e);
      }
    }
  );

  server.registerTool(
    name("get_functionality_details"),
    {
      title: "Get functionality details (step 2/3)",
      description: "Gets the required parameters and detailed information for a specific functionality before executing it.",
      inputSchema: {
        appPath: z.string().describe("Absolute path to the app folder"),
        functionalityId: z.enum(["add_page", "delete_page", "add_controller_extension", "enable_fcl", "enable_initial_load", "update_manifest"]).describe("Functionality id from list_functionality")
      },
      outputSchema: functionalityDetailsOutput,
      annotations: READ_LOCAL
    },
    async (args) => {
      try {
        return json(getFunctionalityDetails(args.appPath, args.functionalityId));
      } catch (e) {
        return err(e);
      }
    }
  );

  server.registerTool(
    name("execute_functionality"),
    {
      title: "Execute a modification functionality (step 3/3)",
      description: "Executes a modification on an existing SAP Fiori application: adds/deletes pages, adds controller extensions, enables FCL or initial load, or updates manifest.json properties.",
      inputSchema: {
        appPath: z.string().describe("Absolute path to the app folder"),
        functionalityId: z.enum(["add_page", "delete_page", "add_controller_extension", "enable_fcl", "enable_initial_load", "update_manifest"]).describe("Functionality id"),
        params: z.record(z.unknown()).optional().describe("Parameters required by the functionality (see get_functionality_details)")
      },
      outputSchema: executeFunctionalityOutput,
      annotations: WRITE_MODIFY
    },
    async (args) => {
      try {
        return json(executeFunctionality(args.appPath, args.functionalityId, args.params ?? {}));
      } catch (e) {
        return err(e);
      }
    }
  );

  // helper tool: read a saved metadata.xml summary (useful between download and generate)
  server.registerTool(
    name("get_metadata_summary"),
    {
      title: "Summarize a metadata.xml",
      description: "Parses a local EDMX metadata.xml and returns entity sets, entity types, keys, associations and annotation targets.",
      inputSchema: {
        metadataXmlPath: z.string().min(1).describe("Path to the metadata.xml file")
      },
      outputSchema: metadataOutput,
      annotations: READ_LOCAL
    },
    async (args) => {
      try {
        const xml = readText(resolvePath(args.metadataXmlPath));
        const model = parseEdmx(xml);
        return json({
          odataVersion: model.version,
          namespaces: model.namespaces,
          entitySets: model.entitySets,
          entityTypes: model.entityTypes,
          annotations: model.annotations.slice(0, 50)
        });
      } catch (e) {
        return err(e);
      }
    }
  );
}
