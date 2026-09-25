import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "../config.js";
import { deployFioriApp } from "../deploy/index.js";
import { validateManifest } from "../ui5/validate.js";
import { json, err, WRITE_REMOTE } from "./index.js";
import { deployAppOutput } from "./schemas.js";

/**
 * Deployment lives in its own registrar because it is the only tool that writes outside this
 * machine: keeping it apart from the local scaffolding tools makes that visible in one place.
 */
export function registerDeployTools(
  server: McpServer,
  config: AppConfig,
  name: (n: string) => string = (n) => n
): void {
  server.registerTool(
    name("deploy_fiori_app"),
    {
      title: "Publish a Fiori app on its SAP system",
      description:
        "Validates the application, builds it (ui5 build, or webapp/ when @ui5/cli is not installed), archives it and uploads it " +
        "to the UI5 Repository service of the target ABAP system — on premise or ABAP Environment on SAP BTP — then fetches the " +
        "public URL to show the app really answers. It publishes: there is no confirmation step, and SafeMode on the system keeps " +
        "it from touching applications that are not yours. The target defaults to the system the app was generated against, read " +
        "back from the manifest service URL; pass systemName (list_sap_systems) or destination (list_btp_destinations) to deploy " +
        "somewhere else. The application goes into package $TMP (local, no transport) unless `package` says otherwise; a real " +
        "package also needs `transport`. Run run_manifest_validation first if you want validation alone.",
      inputSchema: {
        appPath: z
          .string()
          .describe("Absolute path of the generated app folder (the one containing webapp/manifest.json)"),
        destination: z
          .string()
          .optional()
          .describe("BTP destination holding the target system. Wins over systemName and over inference"),
        systemName: z
          .string()
          .optional()
          .describe("System from list_sap_systems. Wins over inference from the manifest"),
        bspName: z
          .string()
          .optional()
          .describe("BSP name (1-15 chars A-Z 0-9 _ , or /namespace/name). Defaults to the app folder name, sanitised"),
        package: z
          .string()
          .optional()
          .describe("ABAP package to record the application in. Default $TMP: local objects, no transport request"),
        transport: z
          .string()
          .optional()
          .describe("Transport request number, required when `package` is a transportable (non-$) package"),
        description: z.string().optional().describe("BSP description, max 60 characters. Defaults to the app title"),
        skipBuild: z
          .boolean()
          .default(false)
          .describe("Archive webapp/ as it is, without installing @ui5/cli or running ui5 build"),
        bootstrap: z
          .enum(["cdn", "local", "keep"])
          .default("cdn")
          .describe(
            "Where index.html loads UI5 from: cdn (ui5.sap.com pinned to the app version), local (the system's own resources, " +
              "probed first), or keep (leave the existing bootstrap alone)"
          ),
        verify: z
          .boolean()
          .default(true)
          .describe("Fetch the public URL after uploading and report the status it answers with"),
        timeoutMs: z.number().optional().describe("Timeout for build and upload, in milliseconds")
      },
      outputSchema: deployAppOutput,
      annotations: WRITE_REMOTE
    },
    async (args) => {
      try {
        const validation = validateManifest(args.appPath);
        if (validation.errors > 0) {
          return json(
            {
              ok: false,
              stage: "validate",
              errors: validation.errors,
              warnings: validation.warnings,
              issues: validation.issues,
              manifestPath: validation.manifestPath,
              hint: "Fix the manifest errors above (run_manifest_validation explains every rule) and call deploy_fiori_app again."
            },
            true
          );
        }
        const result = await deployFioriApp({
          config,
          appPath: args.appPath,
          destination: args.destination,
          systemName: args.systemName,
          bspName: args.bspName,
          abapPackage: args.package,
          transport: args.transport,
          description: args.description,
          skipBuild: args.skipBuild,
          bootstrap: args.bootstrap,
          verify: args.verify,
          timeoutMs: args.timeoutMs
        });
        return json(result, false);
      } catch (e) {
        return err(e);
      }
    }
  );
}
