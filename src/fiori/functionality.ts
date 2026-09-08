import path from "node:path";
import fs from "node:fs";
import { resolvePath, readText, tryReadJson, writeFileSafe, exists } from "../util/fs.js";
import { readAppManifest } from "./apps.js";
import { logger } from "../logger.js";

export type FunctionalityId =
  | "add_page"
  | "delete_page"
  | "add_controller_extension"
  | "enable_fcl"
  | "enable_initial_load"
  | "update_manifest";

export interface FunctionalityInfo {
  id: FunctionalityId;
  title: string;
  description: string;
  parameters: { name: string; type: string; required: boolean; description: string }[];
}

const FUNCTIONALITIES: FunctionalityInfo[] = [
  {
    id: "add_page",
    title: "Add a page to the app",
    description:
      "Adds a new routing target (freestyle XML view page or an additional Fiori elements Object Page for a to-many navigation of the main entity). Creates the view file, registers the route and target in manifest.json.",
    parameters: [
      { name: "viewName", type: "string", required: true, description: "Logical view name, e.g. 'Details' — file webapp/view/Details.view.xml is created for freestyle pages" },
      { name: "routeName", type: "string", required: true, description: "Route name, e.g. 'Details'" },
      { name: "pattern", type: "string", required: true, description: "URL pattern, e.g. 'Details({ID}):?query:'" },
      { name: "objectPageEntitySet", type: "string", required: false, description: "For Fiori elements v4: entity set of the new Object Page target (uses sap.fe.templates.ObjectPage)" },
      { name: "navigationProperty", type: "string", required: false, description: "To-many navigation property name on the main entity used for the pattern" }
    ]
  },
  {
    id: "delete_page",
    title: "Delete a page from the app",
    description: "Removes a route + target from manifest.json and optionally deletes the view file.",
    parameters: [
      { name: "routeName", type: "string", required: true, description: "Name of the route to remove" },
      { name: "deleteViewFile", type: "boolean", required: false, description: "Also delete the view XML file (default false)" }
    ]
  },
  {
    id: "add_controller_extension",
    title: "Add a controller extension",
    description:
      "Creates a controller (or ControllerExtension for Fiori elements v4) and wires it up: freestyle apps get a new controller file next to the view; FE v4 apps get a Component extension module + extends entry in manifest.json.",
    parameters: [
      { name: "controllerName", type: "string", required: true, description: "Logical controller name, e.g. 'ExtendMain' — file webapp/controller/ExtendMain.controller.js is created" },
      { name: "viewName", type: "string", required: false, description: "Freestyle only: view whose controllerName will be replaced/created" },
      { name: "extensionCode", type: "string", required: false, description: "Optional extra method bodies (JS) to insert into the controller" }
    ]
  },
  {
    id: "enable_fcl",
    title: "Enable Flexible Column Layout",
    description:
      "Switches the manifest routing to sap.f.routing.Router, adds the sap.f library and layout mappings, and updates the app view to use sap.f.FlexibleColumnLayout when a freestyle App view exists.",
    parameters: [
      { name: "defaultLayout", type: "string", required: false, description: "OneColumn | TwoColumnsMidExpanded | ThreeColumnsMidExpanded (default TwoColumnsMidExpanded)" }
    ]
  },
  {
    id: "enable_initial_load",
    title: "Enable initial load for the List Report",
    description: "Sets initialLoad: true in every sap.fe.templates.ListReport target so the table loads data without pressing Go.",
    parameters: []
  },
  {
    id: "update_manifest",
    title: "Update a manifest.json property",
    description: "Generic safe update of a JSON pointer path in manifest.json (e.g. sap.app/title). Refuses to replace dataSources/mainService silently.",
    parameters: [
      { name: "jsonPointer", type: "string", required: true, description: "Path with / separators, e.g. 'sap.app/title'" },
      { name: "value", type: "any", required: true, description: "New value (JSON parsed)" }
    ]
  }
];

export function listFunctionalities(_appPath: string): FunctionalityInfo[] {
  return FUNCTIONALITIES;
}

export function getFunctionalityDetails(appPath: string, functionalityId: FunctionalityId): FunctionalityInfo {
  const app = readAppManifest(resolvePath(appPath));
  if (!app) throw new Error(`No Fiori app (manifest.json) found under ${appPath}`);
  const found = FUNCTIONALITIES.find((f) => f.id === functionalityId);
  if (!found) throw new Error(`Unknown functionality '${functionalityId}'. Available: ${FUNCTIONALITIES.map((f) => f.id).join(", ")}`);
  return found;
}

function readManifest(appDir: string): { manifestPath: string; manifest: Record<string, unknown>; webappDir: string } {
  const found = readAppManifest(appDir);
  if (!found) throw new Error(`No manifest.json found under ${appDir}`);
  return found;
}

function saveManifest(found: { manifestPath: string; manifest: Record<string, unknown> }): void {
  fs.writeFileSync(found.manifestPath, JSON.stringify(found.manifest, null, 2) + "\n", "utf8");
}

function getRouting(manifest: Record<string, unknown>): Record<string, unknown> {
  const ui5 = (manifest["sap.ui5"] ??= {}) as Record<string, unknown>;
  const routing = (ui5["routing"] ??= {}) as Record<string, unknown>;
  (routing["routes"] ??= []) as unknown[];
  (routing["targets"] ??= {}) as Record<string, unknown>;
  return routing;
}

function setPointer(obj: Record<string, unknown>, pointer: string, value: unknown): void {
  const parts = pointer.split("/").filter(Boolean);
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    if (typeof cur[key] !== "object" || cur[key] === null) cur[key] = {};
    cur = cur[key] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]] = value;
}

function freeStyleViewTemplate(appId: string, viewName: string, controllerName: string): string {
  return `<mvc:View xmlns:mvc="sap.ui.core.mvc" xmlns="sap.m" controllerName="${controllerName}" displayBlock="true">
  <Page id="${viewName.toLowerCase()}Page" title="{i18n>appTitle}">
    <content>
      <Text text="TODO: content for ${viewName}"/>
    </content>
  </Page>
</mvc:View>
`;
}

export function executeFunctionality(
  appPath: string,
  functionalityId: FunctionalityId,
  params: Record<string, unknown>
): { changed: string[]; created: string[]; message: string } {
  const appDir = resolvePath(appPath);
  const found = readManifest(appDir);
  const manifest = found.manifest;
  const webappDir = found.webappDir;
  const changed: string[] = [];
  const created: string[] = [];
  let message = "";

  const appId = String(((manifest["sap.app"] ?? {}) as Record<string, unknown>)["id"] ?? "app");
  const isFeV4 = JSON.stringify(manifest).includes("sap.fe.templates");

  switch (functionalityId) {
    case "add_page": {
      const routing = getRouting(manifest);
      const routes = routing["routes"] as unknown[];
      const targets = routing["targets"] as Record<string, unknown>;
      const viewName = String(params.viewName ?? "NewPage");
      const routeName = String(params.routeName ?? viewName);
      const pattern = String(params.pattern ?? `${viewName}:?query:`);
      const objectPageEntitySet = params.objectPageEntitySet ? String(params.objectPageEntitySet) : undefined;

      if (routes.some((r) => (r as Record<string, unknown>)["name"] === routeName)) {
        throw new Error(`Route '${routeName}' already exists`);
      }

      if (isFeV4 && objectPageEntitySet) {
        const navProp = params.navigationProperty ? String(params.navigationProperty) : undefined;
        targets[routeName] = {
          type: "Component",
          id: routeName,
          name: "sap.fe.templates.ObjectPage",
          options: {
            settings: {
              entitySet: objectPageEntitySet,
              ...(navProp ? { navigation: { [objectPageEntitySet]: { detail: { outlet: navProp } } } } : {})
            }
          }
        };
        routes.push({ pattern: navProp ? `${objectPageEntitySet}({${navProp}}):?query:` : pattern, name: routeName, target: routeName });
        message = `Object Page target '${routeName}' for entity set '${objectPageEntitySet}' added.`;
      } else {
        // freestyle view page
        const viewFile = path.join(webappDir, "view", `${viewName}.view.xml`);
        const controllerFile = path.join(webappDir, "controller", `${viewName}.controller.js`);
        if (!exists(viewFile)) {
          writeFileSafe(viewFile, freeStyleViewTemplate(appId, viewName, `${appId}.controller.${viewName}`));
          created.push(viewFile);
        }
        if (!exists(controllerFile)) {
          writeFileSafe(
            controllerFile,
            `sap.ui.define(["sap/ui/core/mvc/Controller"], function (Controller) {\n  "use strict";\n\n  return Controller.extend("${appId}.controller.${viewName}", {\n    onInit: function () {}\n  });\n});\n`
          );
          created.push(controllerFile);
        }
        const ui5 = manifest["sap.ui5"] as Record<string, unknown>;
        const rootView = ui5["rootView"] as Record<string, unknown>;
        const viewPathBase = String(routing["config"] ? ((routing["config"] as Record<string, unknown>)["viewPath"] ?? `${appId}.view`) : `${appId}.view`);
        void rootView;
        targets[routeName] = {
          viewName: path.posix.join(...viewPathBase.split(".").slice(-1), viewName).replace(/^\w+\//, ""),
          viewId: routeName
        };
        // set target viewName as plain logical name under viewPath
        targets[routeName] = { viewName: viewName, viewId: routeName };
        routes.push({ pattern, name: routeName, target: routeName });
        message = `Freestyle page '${viewName}' created and route '${routeName}' registered.`;
      }
      saveManifest(found);
      changed.push(found.manifestPath);
      break;
    }

    case "delete_page": {
      const routing = getRouting(manifest);
      const routes = routing["routes"] as unknown[];
      const targets = routing["targets"] as Record<string, unknown>;
      const routeName = String(params.routeName ?? "");
      const targetBefore = targets[routeName] as Record<string, unknown> | undefined;
      const before = routes.length;
      const filtered = routes.filter((r) => (r as Record<string, unknown>)["name"] !== routeName);
      (routing as Record<string, unknown>)["routes"] = filtered;
      delete targets[routeName];
      if (filtered.length === before) throw new Error(`Route '${routeName}' not found`);
      saveManifest(found);
      changed.push(found.manifestPath);
      if (params.deleteViewFile === true && targetBefore) {
        const targetViewName = String(targetBefore["viewName"] ?? routeName);
        const viewFile = path.join(webappDir, "view", `${targetViewName}.view.xml`);
        if (exists(viewFile)) {
          fs.rmSync(viewFile);
          changed.push(viewFile);
        }
      }
      message = `Route '${routeName}' removed from manifest.json.`;
      break;
    }

    case "add_controller_extension": {
      const controllerName = String(params.controllerName ?? "ExtendMain");
      const extra = params.extensionCode ? String(params.extensionCode) : "";
      if (isFeV4) {
        const extFile = path.join(webappDir, "ext", `Extend${controllerName.replace(/^Extend/, "")}.js`);
        writeFileSafe(
          extFile,
          `sap.ui.define([], function () {\n  "use strict";\n\n  return sap.ui.controller.extend || {};\n});\n/* ControllerExtension skeleton for Fiori elements v4:\n\nsap.ui.define([\n  "sap/ui/core/mvc/ControllerExtension"\n], function (ControllerExtension) {\n  "use strict";\n\n  return ControllerExtension.extend("${appId}.ext.${controllerName}", {\n    static: { id: "${controllerName}" },\n    override: {\n      onInit: function () {\n        // ${controllerName}: initialization\n      }${extra ? `,\n      ${extra}` : ""}\n    }\n  });\n});\n*/\n`
        );
        created.push(extFile);
        // register extends
        const ui5 = (manifest["sap.ui5"] ??= {}) as Record<string, unknown>;
        const ext = (ui5["extends"] ??= {}) as Record<string, unknown>;
        const extensions = (ext["extensions"] ??= {}) as Record<string, unknown>;
        setPointer(manifest, `sap.ui5/extends/extensions/sap.fe.controllerExtensions/${appId}.ext.${controllerName}`, `${appId}.ext.${controllerName}`);
        void extensions;
        saveManifest(found);
        changed.push(found.manifestPath);
        message = `Controller extension skeleton created at ext/${controllerName}.js and registered under sap.ui5/extends/extensions.`;
      } else {
        const viewName = params.viewName ? String(params.viewName) : "App";
        const controllerFile = path.join(webappDir, "controller", `${controllerName}.controller.js`);
        writeFileSafe(
          controllerFile,
          `sap.ui.define(["sap/ui/core/mvc/Controller"], function (Controller) {\n  "use strict";\n\n  return Controller.extend("${appId}.controller.${controllerName}", {\n    onInit: function () {\n      // TODO\n    }${extra ? `,\n    ${extra}` : ""}\n  });\n});\n`
        );
        created.push(controllerFile);
        // point view to the new controller if requested view exists
        const viewFile = path.join(webappDir, "view", `${viewName}.view.xml`);
        if (exists(viewFile)) {
          let xml = readText(viewFile);
          if (!xml.includes(`controllerName="${appId}.controller.${controllerName}"`)) {
            xml = xml.replace(/controllerName="[^"]*"/, `controllerName="${appId}.controller.${controllerName}"`);
            fs.writeFileSync(viewFile, xml, "utf8");
            changed.push(viewFile);
          }
        }
        message = `Controller '${controllerName}' created${exists(viewFile) ? ` and view '${viewName}' rewired` : ""}.`;
      }
      break;
    }

    case "enable_fcl": {
      const routing = getRouting(manifest);
      const config = (routing["config"] ??= {}) as Record<string, unknown>;
      config["routerClass"] = "sap.f.routing.Router";
      const ui5 = manifest["sap.ui5"] as Record<string, unknown>;
      const deps = (ui5["dependencies"] ??= {}) as Record<string, unknown>;
      const libs = (deps["libs"] ??= {}) as Record<string, unknown>;
      libs["sap.f"] = {};
      routing["layouts"] = {
        OneColumn: "OneColumn",
        TwoColumnsMidExpanded: "TwoColumnsMidExpanded",
        ThreeColumnsMidExpanded: "ThreeColumnsMidExpanded"
      };
      // map routes to columns: first target -> begin, second -> mid, third -> end
      const routes = routing["routes"] as Record<string, unknown>[];
      routes.forEach((route, i) => {
        if (!route["level"]) route["level"] = Math.min(i, 2);
      });
      const appView = path.join(webappDir, "view", "App.view.xml");
      if (exists(appView)) {
        let xml = readText(appView);
        if (!xml.includes("FlexibleColumnLayout")) {
          xml = xml.replace(/<App[\s>]/g, '<f:FlexibleColumnLayout id="layout" xmlns:f="sap.f">').replace(/<\/App>/g, "</f:FlexibleColumnLayout>");
          if (!xml.includes('xmlns:f="sap.f"') && !xml.includes("FlexibleColumnLayout")) {
            // replace default App shell
            xml = xml.replace("<pages>", `<f:beginColumnPages><pages></pages></f:beginColumnPages>`);
          }
          fs.writeFileSync(appView, xml, "utf8");
          changed.push(appView);
        }
      }
      saveManifest(found);
      changed.push(found.manifestPath);
      message = `Flexible Column Layout enabled (default layout: ${String(params.defaultLayout ?? "TwoColumnsMidExpanded")}).`;
      break;
    }

    case "enable_initial_load": {
      const routing = getRouting(manifest);
      const targets = routing["targets"] as Record<string, Record<string, unknown>>;
      let touched = 0;
      for (const t of Object.values(targets)) {
        const name = String(t["name"] ?? "");
        if (name === "sap.fe.templates.ListReport") {
          const settings = ((t["options"] ??= {}) as Record<string, unknown>)["settings"] ??= {};
          (settings as Record<string, unknown>)["initialLoad"] = true;
          touched++;
        }
      }
      if (!touched) throw new Error("No sap.fe.templates.ListReport targets found in manifest.json");
      saveManifest(found);
      changed.push(found.manifestPath);
      message = `initialLoad enabled on ${touched} List Report target(s).`;
      break;
    }

    case "update_manifest": {
      const pointer = String(params.jsonPointer ?? "");
      if (!pointer) throw new Error("jsonPointer is required");
      if (pointer.startsWith("sap.app/dataSources/mainService")) {
        throw new Error("Refusing to silently replace the main service definition; edit it explicitly or use update_manifest on a different path.");
      }
      setPointer(manifest, pointer, params.value);
      saveManifest(found);
      changed.push(found.manifestPath);
      message = `manifest.json updated at '${pointer}'.`;
      break;
    }
  }

  logger.info("executeFunctionality", { functionalityId, appDir, changed, created });
  return { changed, created, message };
}

/** Convenience helper used by tools layer to validate app dir before other tools run. */
export function requireManifestJson(appPath: string): Record<string, unknown> {
  const manifest = tryReadJson<Record<string, unknown>>(path.join(resolvePath(appPath), "webapp", "manifest.json"));
  if (!manifest) throw new Error(`manifest.json not found in ${appPath}/webapp`);
  return manifest;
}
