import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "../config.js";
import { createUi5App, createIntegrationCard } from "../ui5/scaffold.js";
import { getApiReference, CURATED_CONTROLS } from "../ui5/api.js";
import { getVersionInfo } from "../ui5/versions.js";
import { getProjectInfo } from "../ui5/project.js";
import { validateManifest } from "../ui5/validate.js";
import { runUi5Linter } from "../ui5/linter.js";
import { relativePaths } from "../util/fs.js";
import { json, err, READ_LOCAL, READ_REMOTE, WRITE_CREATE } from "./index.js";
import { scaffoldOutput, apiReferenceOutput, projectInfoOutput, versionInfoOutput, manifestValidationOutput, linterOutput } from "./schemas.js";

export function registerUi5Tools(server: McpServer, config: AppConfig, name: (n: string) => string = (n) => n): void {
  server.registerTool(
    name("create_ui5_app"),
    {
      title: "Scaffold a new UI5 freestyle application",
      description:
        "Creates a new UI5 freestyle app from templates: 'basic' (single page), 'worklist' (searchable table + object page, OData V2), 'master-detail' (FCL, 2 columns), 'fcl' (Flexible Column Layout with column routing) or 'tabs' (IconTabBar page). " +
        "Generates manifest.json, Component.js, views, controllers, i18n, index.html, ui5.yaml and package.json. Fails if the target folder already exists.",
      inputSchema: {
        targetPath: z.string().optional().describe("Folder where the app folder is created (default workspace root)"),
        name: z.string().min(1).describe("App name / folder name, e.g. 'shop'"),
        namespace: z.string().default("ns").describe("App id namespace, e.g. 'my.company'"),
        title: z.string().min(1).describe("App title"),
        template: z.enum(["basic", "worklist", "master-detail", "fcl", "tabs"]).default("basic").describe("Template"),
        serviceUri: z.string().optional().describe("OData service URL for worklist/master-detail/fcl templates"),
        ui5Version: z.string().optional().describe("UI5 version for bootstrap and minUI5Version (default 1.120.0)")
      },
      outputSchema: scaffoldOutput,
      annotations: WRITE_CREATE
    },
    async (args) => {
      try {
        const root = args.targetPath ?? config.workspaceRoot;
        const { appPath, files } = createUi5App(root, {
          name: args.name,
          namespace: args.namespace,
          title: args.title,
          template: args.template,
          serviceUri: args.serviceUri,
          ui5Version: args.ui5Version
        });
        return json({
          appPath,
          createdFiles: relativePaths(files, root),
          nextSteps: [`cd ${appPath}`, "npm install", "npm start (ui5 serve --open index.html)"]
        });
      } catch (e) {
        return err(e);
      }
    }
  );

  server.registerTool(
    name("create_integration_card"),
    {
      title: "Scaffold a UI Integration Card",
      description: "Creates a manifest-based UI Integration Card (List, Object, Table, Timeline, Analytical, Adaptive, Component, Calendar) with preview index.html. Fails if the target folder already exists.",
      inputSchema: {
        targetPath: z.string().optional().describe("Folder where the card folder is created"),
        name: z.string().min(1).describe("Card name / folder name"),
        cardType: z.enum(["List", "Object", "Table", "Timeline", "Analytical", "Adaptive", "Component", "Calendar"]).default("List").describe("Card type"),
        title: z.string().optional().describe("Card title"),
        namespace: z.string().optional().describe("Card id namespace"),
        dataUrl: z.string().optional().describe("Data request URL for the card")
      },
      outputSchema: scaffoldOutput,
      annotations: WRITE_CREATE
    },
    async (args) => {
      try {
        const root = args.targetPath ?? config.workspaceRoot;
        const { appPath, files } = createIntegrationCard(root, args);
        return json({ appPath, createdFiles: relativePaths(files, root) });
      } catch (e) {
        return err(e);
      }
    }
  );

  server.registerTool(
    name("get_api_reference"),
    {
      title: "Get UI5 API reference for a control",
      description:
        "Fetches and formats the UI5 API reference (properties, aggregations, events, methods with JSDoc) for a control such as 'sap.m.Table'. " +
        "Source: official UI5 TypeScript type definitions (@openui5/ts-types-esm), cached locally after first use.",
      inputSchema: {
        controlName: z.string().min(1).describe("Full control name, e.g. 'sap.m.Table' or 'sap.ui.layout.form.SimpleForm'"),
        ui5Version: z.string().optional().describe("UI5 version (default 1.120.0 LTS)")
      },
      outputSchema: apiReferenceOutput,
      annotations: READ_REMOTE
    },
    async (args) => {
      try {
        return json(await getApiReference(config, args.controlName, args.ui5Version));
      } catch (e) {
        const curated = CURATED_CONTROLS[args.controlName];
        return json(
          {
            error: e instanceof Error ? e.message : String(e),
            fallback: curated ?? null,
            hint: curated
              ? "Offline fallback summary provided; the CDN copy of the type definitions was not reachable."
              : "Check the control name (full namespace, e.g. 'sap.m.Table'); fetching the type definitions failed."
          },
          true
        );
      }
    }
  );

  server.registerTool(
    name("get_project_info"),
    {
      title: "Get UI5 project info",
      description: "Extracts metadata and configuration from a UI5 or CAP project: app ids, framework version, libraries, views, controllers, models, routing, data sources and package scripts.",
      inputSchema: {
        projectPath: z.string().optional().describe("Project folder (default workspace root)")
      },
      outputSchema: projectInfoOutput,
      annotations: READ_LOCAL
    },
    async (args) => {
      try {
        return json(getProjectInfo(args.projectPath ?? config.workspaceRoot));
      } catch (e) {
        return err(e);
      }
    }
  );

  server.registerTool(
    name("get_version_info"),
    {
      title: "Get UI5 framework version info",
      description: "Retrieves UI5 framework version information: latest version from the CDN (sap-ui-version.json) plus the local project's configured version.",
      inputSchema: {
        projectPath: z.string().optional().describe("Optional local project to read its minUI5Version/ui5.yaml version")
      },
      outputSchema: versionInfoOutput,
      annotations: READ_REMOTE
    },
    async (args) => {
      try {
        return json(await getVersionInfo(config, args.projectPath));
      } catch (e) {
        return err(e);
      }
    }
  );

  server.registerTool(
    name("run_manifest_validation"),
    {
      title: "Validate a UI5 manifest.json",
      description: "Validates the manifest against UI5 rules: sap.app id pattern, dataSources, model references, routing targets, view/i18n files on disk, card structure.",
      inputSchema: {
        appPath: z.string().min(1).describe("App folder (or direct path to manifest.json)")
      },
      outputSchema: manifestValidationOutput,
      annotations: READ_LOCAL
    },
    async (args) => {
      try {
        return json(validateManifest(args.appPath));
      } catch (e) {
        return err(e);
      }
    }
  );

  server.registerTool(
    name("run_ui5_linter"),
    {
      title: "Lint UI5 code",
      description: "Analyzes JS/XML code of a UI5 app for common issues: deprecated APIs (jQuery.sap.*, sap.ui.getCore().byId), removed libraries, deprecated controls, missing controllers and missing i18n keys.",
      inputSchema: {
        projectPath: z.string().min(1).describe("App or project folder to lint (scans webapp/)"),
        files: z.array(z.string()).optional().describe("Restrict to specific files")
      },
      outputSchema: linterOutput,
      annotations: READ_LOCAL
    },
    async (args) => {
      try {
        return json(runUi5Linter(args.projectPath, { files: args.files }));
      } catch (e) {
        return err(e);
      }
    }
  );
}
