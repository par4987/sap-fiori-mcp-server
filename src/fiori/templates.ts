/**
 * Templates for generated Fiori / UI5 applications.
 * All generators return { "relative/path": "content" } maps written by the generate module.
 *
 * Floorplans:
 *   - list-report          : List Report + Object Page (OData V4 sap.fe.templates / V2 sap.suite.ui.generic.template)
 *   - object-page          : standalone Object Page / form entry (OData V4 only)
 *   - worklist             : task-oriented List Report variant with initialLoad (V4 + V2)
 *   - analytical-list-page : Analytical List Page (OData V2, sap.suite.ui.generic.template.AnalyticalListPage)
 *   - overview-page        : Overview Page with cards (OData V2, sap.ovp)
 */

export type Floorplan = "list-report" | "object-page" | "worklist" | "analytical-list-page" | "overview-page";

export interface FeAppOptions {
  namespace: string; // e.g. "ns.travelapp"
  appId: string; // namespace + name
  appName: string; // folder/file name, e.g. "travelapp"
  title: string;
  description?: string;
  entitySet: string; // e.g. "Travel"
  mainEntity: string; // entity type short name e.g. "Travel"
  navEntity?: { entitySet: string; entity: string; navigationProperty: string }; // to-many for object page facet (optional second OP)
  odataVersion: "2.0" | "4.0";
  serviceUri: string;
  /** Annotation documents to declare alongside the service (V2 keeps its UI annotations apart). */
  annotations?: { name: string; uri: string; localUri: string }[];
  /**
   * Set when the app is built on a CDS with parameters. The rows then live behind a navigation,
   * so the pages are addressed by context path and sap.fe asks for the parameters before loading.
   */
  parameters?: { entitySet: string; navigation: string; keys: string[] };
  /** Fields an overview page card shows, taken from the entity rather than invented. */
  cardFields?: { title: string; subtitle?: string };
  addFcl: boolean;
  floorplan: Floorplan;
  initialLoad?: boolean;
  typescript?: boolean;
}

function sourceTemplateId(o: FeAppOptions): string {
  const base = "sap-fiori-mcp-server.fiori-elements-";
  switch (o.floorplan) {
    case "object-page":
      return `${base}v4-object-page`;
    case "worklist":
      return `${base}${o.odataVersion === "4.0" ? "v4" : "v2"}-worklist`;
    case "analytical-list-page":
      return `${base}v2-alp`;
    case "overview-page":
      return `${base}v2-ovp`;
    default:
      return `${base}${o.odataVersion === "4.0" ? "v4" : "v2"}`;
  }
}

function feSapApp(o: FeAppOptions): string {
  return `  "sap.app": {
    "id": "${o.appId}",
    "type": "application",
    "i18n": "i18n/i18n.properties",
    "applicationVersion": {
      "version": "1.0.0"
    },
    "title": "{{appTitle}}",
    "description": "{{appDescription}}",
    "dataSources": {
      "mainService": {
        "uri": "${o.serviceUri}",
        "type": "OData",
        "settings": {
          "odataVersion": "${o.odataVersion}",
          "localUri": "localService/metadata.xml"${annotationRef(o)}
        }
      }${annotationSources(o)}
    },
    "sourceTemplate": {
      "id": "${sourceTemplateId(o)}",
      "version": "1.0.0"
    }
  }`;
}

/** The mainService side of an annotation reference: which data sources carry its annotations. */
function annotationRef(o: FeAppOptions): string {
  const names = (o.annotations ?? []).map((a) => a.name);
  return names.length ? `,
          "annotations": [${names.map((n) => `"${n}"`).join(", ")}]` : "";
}

/** The annotation data sources themselves, each with the copy saved under localService/. */
function annotationSources(o: FeAppOptions): string {
  return (o.annotations ?? [])
    .map(
      (a) => `,
      "${a.name}": {
        "uri": "${a.uri}",
        "type": "ODataAnnotation",
        "settings": {
          "localUri": "${a.localUri}"
        }
      }`
    )
    .join("");
}

function feSapUi(o: FeAppOptions): string {
  return `  "sap.ui": {
    "technology": "UI5",
    "icons": {
      "icon": "",
      "favIcon": "",
      "phone": "",
      "phone@2": "",
      "tablet": "",
      "tablet@2": ""
    },
    "deviceTypes": {
      "desktop": true,
      "tablet": true,
      "phone": true
    }
  }`;
}

function feModelSettings(o: FeAppOptions): string {
  const v4 = o.odataVersion === "4.0";
  return `"models": {
      "i18n": {
        "type": "sap.ui.model.resource.ResourceModel",
        "settings": {
          "bundleName": "${o.appId}.i18n.i18n"
        }
      },${v4 ? `
      "": {
        "dataSource": "mainService",
        "preload": true,
        "settings": {
          "synchronizationMode": "None",
          "operationMode": "Server",
          "autoExpandSelect": true,
          "earlyRequests": true,
          "groupProperties": {
            "default": {
              "submit": "Auto"
            }
          }
        }
      }` : `
      "": {
        "dataSource": "mainService",
        "preload": true,
        "type": "sap.ui.model.odata.v2.ODataModel",
        "settings": {
          "defaultBindingMode": "TwoWay",
          "defaultCountMode": "Inline",
          "refreshAfterChange": false,
          "useBatch": true
        }
      }`}
    }`;
}

function routingConfig(o: FeAppOptions, overrides: { routerClass?: string } = {}): string {
  const fclLayouts = o.addFcl
    ? `,\n      "layouts": {\n        "OneColumn": "OneColumn",\n        "TwoColumnsMidExpanded": "TwoColumnsMidExpanded",\n        "ThreeColumnsMidExpanded": "ThreeColumnsMidExpanded"\n      }`
    : "";
  const fclConfig = o.addFcl
    ? `,\n          "controlId": "layout",\n          "controlAggregation": "beginColumnPages"`
    : "";
  // sap.fe insists the root view and the router class match, and says so plainly when they do not:
  // NavContainer goes with sap.m.routing.Router, Fcl with sap.f.routing.Router. Nothing else
  // belongs in a v4 config — viewType and viewPath describe views the app does not own.
  if (o.odataVersion === "4.0") {
    return `"routing": {
      "config": {
        "routerClass": "${o.addFcl ? "sap.f.routing.Router" : "sap.m.routing.Router"}"
      }${fclLayouts},`;
  }
  return `"routing": {
      "config": {
        "routerClass": "${overrides.routerClass ?? (o.addFcl ? "sap.f.routing.Router" : "sap.m.routing.Router")}",
        "viewType": "XML",
        "async": true,
        "viewPath": "${o.appId}.view",
        "clearControlAggregation": false${fclConfig}
      }${fclLayouts},`;
}

function feDependencies(o: FeAppOptions, extraLibs: string[] = []): string {
  const v4 = o.odataVersion === "4.0";
  const feLibs = o.floorplan === "overview-page"
    ? '\n        "sap.ovp": {},'
    : v4
      ? '\n        "sap.fe.templates": {},'
      : '\n        "sap.suite.ui.generic.template": {},\n        "sap.ui.comp": {},\n        "sap.ushell": {},';
  const chartLibs = o.floorplan === "analytical-list-page" ? '\n        "sap.chart": {},\n        "sap.suite.ui.microchart": {},' : "";
  const fLib = o.addFcl ? '\n        "sap.f": {},' : "";
  return `"dependencies": {
      "minUI5Version": "${ui5Version(o)}",
      "libs": {
        "sap.m": {},${feLibs}${chartLibs}
        "sap.ui.core": {},${fLib}
        "sap.ui.layout": {}${extraLibs.length ? extraLibs.map((l) => `,\n        "${l}": {}`).join("") : ""}
      }
    }`;
}

// ---------------------------------------------------------------------------
// Routing targets per floorplan
// ---------------------------------------------------------------------------

/**
 * How a page names the data it shows.
 *
 * An ordinary page points at an entity set. A parameterised one cannot: the set holds parameter
 * records, and the rows sit behind its navigation, so the page is addressed by the path through it
 * — which is also what makes sap.fe ask for the parameters before it loads anything.
 */
function pageContext(o: FeAppOptions): string {
  return o.parameters
    ? `"contextPath": "/${o.parameters.entitySet}/${o.parameters.navigation}"`
    : `"entitySet": "${o.entitySet}"`;
}

/** The object page's route: through the parameters when there are any, by key when there are not. */
function objectPagePattern(o: FeAppOptions): string {
  // sap.fe binds the object page from the route's key parameter; for a parameterised entity it
  // expects the plain name 'key', not one derived from the entity
  const key = o.parameters ? "key" : `${o.mainEntity.charAt(0).toLowerCase()}${o.mainEntity.slice(1)}Key`;
  if (!o.parameters) return `${o.mainEntity}({${key}}):?query:`;
  const params = o.parameters.keys.map((k) => `${k}={${k}}`).join(",");
  return `${o.parameters.entitySet}(${params})/${o.parameters.navigation}({${key}}):?query:`;
}

/**
 * The root view of a Fiori elements app.
 *
 * A v4 app must not name a template's own view here: sap.fe builds its pages from routing targets,
 * and pointing rootView at sap.fe.templates.<Floorplan>.view.<Floorplan> makes UI5 load a file that
 * ships inside the library preload and not as a resource — the app then dies on a 404 and renders
 * nothing. What belongs here is the container sap.fe navigates inside: NavContainer, or Fcl for a
 * flexible column layout. The v2 templates do name their view, and there it is correct.
 */
function feRootView(o: FeAppOptions, v2ViewName: string): string {
  const v4 = o.odataVersion === "4.0";
  // a v2 app's AppComponent builds its own NavContainer from sap.ui.generic.app; naming a view here
  // only gives it a second, empty one
  if (!v4) return "";
  const viewName = o.addFcl ? "sap.fe.core.rootView.Fcl" : "sap.fe.core.rootView.NavContainer";
  const id = "appRootView";
  void v2ViewName;
  return `"rootView": {
      "viewName": "${viewName}",
      "type": "XML",
      "async": true,
      "id": "${id}"
    },`;
}

/**
 * The object page route, where there is one.
 *
 * sap.fe has no object page for a parameterised entity: its converter knows nothing about
 * parameters, so it resolves the page against the parameter entity and asks the service for
 * `…/Set('1')/p_from` and `…/Set('1')/Set/TravelId` — paths that do not exist. The requests fail,
 * the batch fails with them, and the page opens empty. A list report on its own works, so that is
 * what such a service gets, and the caller is told why rather than shown a detail page that cannot
 * load.
 */
function objectPageRoute(o: FeAppOptions): string {
  if (o.parameters) return "";
  return `{
        "pattern": "${objectPagePattern(o)}",
        "name": "${o.mainEntity}ObjectPage",
        "target": "${o.mainEntity}ObjectPage"
      }`;
}

/** The object page target, omitted for a parameterised service — see objectPageRoute. */
function objectPageTarget(o: FeAppOptions, opNav: string): string {
  if (o.parameters) return "";
  return `,
      "${o.mainEntity}ObjectPage": {
        "type": "Component",
        "id": "${o.mainEntity}ObjectPage",
        "name": "sap.fe.templates.ObjectPage",
        "options": {
          "settings": {
            ${pageContext(o)}${opNav}
          }
        }
      }`;
}

/**
 * The page hierarchy a v2 Fiori elements app is built from.
 *
 * The v2 templates do not read routing targets: sap.ui.generic.app is where they find their pages,
 * and without it AppComponent starts, finds nothing to show and logs "page stack is empty but
 * should have been initialized". The v4 templates use routing instead and want none of this.
 */
function v2GenericApp(o: FeAppOptions): string {
  if (o.odataVersion === "4.0") return "";
  const listComponent =
    o.floorplan === "analytical-list-page"
      ? "sap.suite.ui.generic.template.AnalyticalListPage"
      : "sap.suite.ui.generic.template.ListReport";
  const pageKind = o.floorplan === "analytical-list-page" ? "AnalyticalListPage" : "ListReport";
  return `,
  "sap.ui.generic.app": {
    "_version": "1.3.0",
    "settings": {},
    "pages": {
      "${pageKind}|${o.entitySet}": {
        "entitySet": "${o.entitySet}",
        "component": {
          "name": "${listComponent}",
          "list": true,
          "settings": {
            "smartVariantManagement": true
          }
        },
        "pages": {
          "ObjectPage|${o.entitySet}": {
            "entitySet": "${o.entitySet}",
            "component": {
              "name": "sap.suite.ui.generic.template.ObjectPage"
            }
          }
        }
      }
    }
  }`;
}

/**
 * The routing section, which belongs to a v4 app only.
 *
 * A v2 app's AppComponent builds its own routing from sap.ui.generic.app. A hand-written one beside
 * it leaves the container with a page stack it never fills — the app renders nothing at all.
 */
function routingSection(o: FeAppOptions, targets: (o: FeAppOptions) => string, overrides: { routerClass?: string } = {}): string {
  if (o.odataVersion !== "4.0") return "";
  // routingConfig opens the routing object; the targets close it
  return `,
    ${routingConfig(o, overrides)}
    ${targets(o)}
  }`;
}

function lrRoutingTargets(o: FeAppOptions): string {
  // Without this the list report has no way to reach its object page: clicking a row selects a cell
  // and nothing else happens. sap.fe only navigates where the manifest says a row leads — and on a
  // parameterised service there is nowhere to go, because it gets no object page at all.
  const navSettings = o.parameters
    ? ""
    : `,
            "navigation": {
              "${o.mainEntity}": {
                "detail": { "route": "${o.mainEntity}ObjectPage" }
              }
            }`;
  const opNav = o.navEntity
    ? `,\n            "navigation": {\n              "${o.mainEntity}": {\n                "detail": { "outlet": "${o.navEntity.navigationProperty}" }\n              }\n            }`
    : "";
  const secondRoute =
    o.navEntity && !o.addFcl
      ? `{\n        "pattern": "${o.navEntity.entitySet}({${o.navEntity.navigationProperty}}):?query:",\n        "name": "${o.navEntity.entitySet}ObjectPage",\n        "target": "${o.navEntity.entitySet}ObjectPage"\n      }`
      : "";
  const secondTarget =
    o.navEntity && !o.addFcl
      ? `,\n      "${o.navEntity.entitySet}ObjectPage": {\n        "type": "Component",\n        "id": "${o.navEntity.entitySet}ObjectPage",\n        "name": "sap.fe.templates.ObjectPage",\n        "options": {\n          "settings": {\n            "entitySet": "${o.navEntity.entitySet}"\n          }\n        }\n      }`
      : "";
  const v2Template = "sap.suite.ui.generic.template.ListReport";
  const listRoute = `{
        "pattern": ":?query:",
        "name": "${o.mainEntity}List",
        "target": "${o.mainEntity}List"
      }`;
  const routeList = [listRoute, objectPageRoute(o), secondRoute].filter((r) => r).join("," + String.fromCharCode(10) + "      ");
  return `"routes": [
      ${routeList}
    ],
    "targets": {
      "${o.mainEntity}List": {
        "type": "Component",
        "id": "${o.mainEntity}List",
        "name": "${o.odataVersion === "4.0" ? "sap.fe.templates.ListReport" : v2Template}",
        "options": {
          "settings": {
            ${pageContext(o)},
            "variantManagement": "Page",
            "initialLoad": ${o.floorplan === "worklist" ? (o.initialLoad ?? true) : (o.initialLoad ?? false)}${navSettings},
            "controlConfiguration": {
              "@com.sap.vocabularies.UI.v1.LineItem": {
                "tableSettings": {
                  "type": "GridTable",
                  "personalization": "std"
                }
              }
            }
          }
        }
      }${objectPageTarget(o, opNav)}${secondTarget}
    }`;
}

function opRoutingTargets(o: FeAppOptions): string {
  return `"routes": [
      {
        "pattern": ":?query:",
        "name": "${o.mainEntity}ObjectPage",
        "target": "${o.mainEntity}ObjectPage"
      }
    ],
    "targets": {
      "${o.mainEntity}ObjectPage": {
        "type": "Component",
        "id": "${o.mainEntity}ObjectPage",
        "name": "sap.fe.templates.ObjectPage",
        "options": {
          "settings": {
            "entitySet": "${o.entitySet}",
            "variantManagement": "Page"
          }
        }
      }
    }`;
}

function alpRoutingTargets(o: FeAppOptions): string {
  const lowerKey = o.mainEntity.charAt(0).toLowerCase() + o.mainEntity.slice(1);
  return `"routes": [
      {
        "pattern": ":?query:",
        "name": "${o.mainEntity}List",
        "target": "${o.mainEntity}List"
      },
      {
        "pattern": "${o.mainEntity}({${lowerKey}Key}):?query:",
        "name": "${o.mainEntity}ObjectPage",
        "target": "${o.mainEntity}ObjectPage"
      }
    ],
    "targets": {
      "${o.mainEntity}List": {
        "type": "Component",
        "id": "${o.mainEntity}List",
        "name": "sap.suite.ui.generic.template.AnalyticalListPage",
        "options": {
          "settings": {
            "entitySet": "${o.entitySet}",
            "variantManagement": "Page",
            "initialLoad": ${o.initialLoad ?? true}
          }
        }
      },
      "${o.mainEntity}ObjectPage": {
        "type": "Component",
        "id": "${o.mainEntity}ObjectPage",
        "name": "sap.suite.ui.generic.template.ObjectPage",
        "options": {
          "settings": {
            "entitySet": "${o.entitySet}"
          }
        }
      }
    }`;
}

// ---------------------------------------------------------------------------
// Manifest builders
// ---------------------------------------------------------------------------

/** List Report / Worklist manifest (V4 + V2). */
function lrManifest(o: FeAppOptions): string {
  const v4 = o.odataVersion === "4.0";
  return `{
  "_version": "1.65.0",
${feSapApp(o)},
${feSapUi(o)},
  "sap.ui5": {
    "flexEnabled": false,
    ${feDependencies(o)},
    "content": {
      "suffix": "custom"
    },
    ${feModelSettings(o)},
    ${feRootView(o, "sap.suite.ui.generic.template.ListReport.view.ListReport")}
    "flexAware": false${routingSection(o, lrRoutingTargets)}
  }${v2GenericApp(o)}
}`;
}

/** Standalone Object Page / form entry manifest (V4 only). */
function opManifest(o: FeAppOptions): string {
  return `{
  "_version": "1.65.0",
${feSapApp(o)},
${feSapUi(o)},
  "sap.ui5": {
    "flexEnabled": false,
    ${feDependencies(o)},
    "content": {
      "suffix": "custom"
    },
    ${feModelSettings(o)},
    ${feRootView(o, "sap.suite.ui.generic.template.ObjectPage.view.Details")}
    ${routingConfig(o, { routerClass: "sap.m.routing.Router" })}
    ${opRoutingTargets(o)}
  }
  }
}`;
}

/** Analytical List Page manifest (V2 only). */
function alpManifest(o: FeAppOptions): string {
  return `{
  "_version": "1.65.0",
${feSapApp(o)},
${feSapUi(o)},
  "sap.ui5": {
    "flexEnabled": false,
    ${feDependencies(o)},
    "content": {
      "suffix": "custom"
    },
    ${feModelSettings(o)},
    ${feRootView(o, "sap.suite.ui.generic.template.AnalyticalListPage.view.AnalyticalListPage")}
    "flexAware": false${routingSection(o, alpRoutingTargets, { routerClass: "sap.m.routing.Router" })}
  }${v2GenericApp(o)}
}`;
}

/** Overview Page manifest (V2 only, sap.ovp). */
function ovpManifest(o: FeAppOptions): string {
  return `{
  "_version": "1.65.0",
${feSapApp(o)},
${feSapUi(o)},
  "sap.ovp": {
    "cards": {
      "card00": {
        "model": "",
        "template": "sap.ovp.cards.list",
        "settings": {
          "title": "{{cardTitle}}",
          "subTitle": "{{cardSubtitle}}",
          "entitySet": "${o.entitySet}",
          "listFlavor": "Standard",
          "itemTitle": "${o.cardFields?.title ?? "/Name"}",
          "itemSubTitle": "${o.cardFields?.subtitle ?? "/Description"}"
        }
      }
    }
  },
  "sap.ui5": {
    "flexEnabled": false,
    ${feDependencies(o)},
    "content": {
      "suffix": "ovp"
    },
    ${feModelSettings(o)},
    "rootView": {
      "viewName": "sap.ovp.app.Main",
      "type": "XML",
      "async": true,
      "id": "ovpMain"
    }
  }
}`;
}

export function feManifest(o: FeAppOptions): string {
  switch (o.floorplan) {
    case "object-page":
      return opManifest(o);
    case "analytical-list-page":
      return alpManifest(o);
    case "overview-page":
      return ovpManifest(o);
    default:
      return lrManifest(o); // list-report | worklist
  }
}

export function feComponentJs(o: FeAppOptions): string {
  if (o.floorplan === "overview-page") {
    return `sap.ui.define(["sap/ovp/app/Component"], function (AppComponent) {
  "use strict";

  return AppComponent.extend("${o.appId}.Component", {
    metadata: {
      manifest: "json"
    }
  });
});
`;
  }
  if (o.odataVersion === "4.0") {
    return `sap.ui.define(["sap/fe/core/AppComponent"], function (AppComponent) {
  "use strict";

  return AppComponent.extend("${o.appId}.Component", {
    metadata: {
      manifest: "json"
    }
  });
});
`;
  }
  return `sap.ui.define(["sap/suite/ui/generic/template/lib/AppComponent"], function (AppComponent) {
  "use strict";

  return AppComponent.extend("${o.appId}.Component", {
    metadata: {
      manifest: "json"
    }
  });
});
`;
}

export function feIndexHtml(o: FeAppOptions): string {
  const v4 = o.odataVersion === "4.0";
  // the bootstrap attribute is a comma-separated list, not JSON: quoting each name put double
  // quotes inside a double-quoted attribute, which ends it early and leaves the page with no
  // libraries at all
  const libs =
    o.floorplan === "overview-page"
      ? "sap.m,sap.ovp"
      : o.floorplan === "analytical-list-page" || !v4
        ? "sap.m,sap.suite.ui.generic.template"
        : "sap.m,sap.fe.templates";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${o.title}</title>
  <!-- the component container is 100% of a body that has no height of its own, so without this the
       app renders correctly and occupies nothing -->
  <style>
    html, body, #content, #root { height: 100%; margin: 0; }
  </style>
  <script id="sap-ui-bootstrap"
    src="resources/sap-ui-core.js"
    data-sap-ui-theme="sap_horizon"
    data-sap-ui-compat-version="edge"
    data-sap-ui-libraries="${libs}"
    data-sap-ui-async="true"
    data-sap-ui-oninit="module:sap/ui/core/ComponentSupport"
    data-sap-ui-flexibility-services='[{"connector": "SessionStorageConnector", "connectorPersonalization": true}]'
    data-sap-ui-resourceroots='{
      "${o.appId}": "./"
    }'>
  </script>
</head>
<body class="sapUiBody" id="content">
  <!-- ComponentSupport reads data-name/data-id/data-settings; the sap-ui-prefixed spellings
       belong to the bootstrap script and are ignored here, leaving the container with no
       component to start -->
  <div data-sap-ui-component
       data-name="${o.appId}"
       data-id="container"
       data-settings='{"id": "${o.appId}"}'
       data-height="100%"
       id="root"></div>
</body>
</html>
`;
}

export function feI18n(o: FeAppOptions): string {
  const ovpKeys =
    o.floorplan === "overview-page"
      ? `\ncardTitle=${o.entitySet} overview
cardSubtitle=Generated by sap-fiori-mcp-server
`
      : "";
  return `# This is the resource bundle for ${o.title}

appTitle=${o.title}
appDescription=${o.description ?? o.title}${ovpKeys}
`;
}

/**
 * The libraries the app needs at runtime, as the UI5 tooling resolves them.
 *
 * Without a framework block `ui5 serve` and `ui5 build` have nowhere to get /resources from, so the
 * app the generator writes cannot be started by the very script it ships. The floorplan decides
 * which template library belongs here, and the theme library is what keeps the app from rendering
 * unstyled.
 */
function frameworkLibraries(o: FeAppOptions): string[] {
  const v4 = o.odataVersion === "4.0";
  const templates =
    o.floorplan === "overview-page"
      ? // sap.ovp reaches for sap.fe at runtime and the tooling does not resolve it on its own:
        // without these the cards never load and the page stays blank
        ["sap.ovp", "sap.fe.macros", "sap.fe.placeholder", "sap.ui.comp", "sap.ushell"]
      : v4
        ? ["sap.fe.templates"]
        : // the v2 smart templates do not run without these two, and the manifest names them
          ["sap.suite.ui.generic.template", "sap.ui.comp", "sap.ushell"];
  const charts = o.floorplan === "analytical-list-page" ? ["sap.chart", "sap.suite.ui.microchart"] : [];
  return [
    "sap.m",
    "sap.ui.core",
    "sap.ui.layout",
    ...(o.addFcl ? ["sap.f"] : []),
    ...templates,
    ...charts,
    "themelib_sap_horizon"
  ];
}

/**
 * The UI5 version the app targets.
 *
 * The manifest's minUI5Version and the framework version in ui5.yaml have to agree: the tooling
 * downloads what ui5.yaml asks for, and sap.fe moved files between releases, so a manifest written
 * for one release served by another fails on a missing view rather than on anything the app did.
 */
export function ui5Version(o: FeAppOptions): string {
  return o.odataVersion === "4.0" ? "1.130.0" : "1.96.0";
}

export function feUi5Yaml(o: FeAppOptions, isCap: boolean): string {
  const framework = `framework:
  name: SAPUI5
  version: "${ui5Version(o)}"
  libraries:
${frameworkLibraries(o)
  .map((l) => `    - name: ${l}`)
  .join(`
`)}`;
  if (isCap) {
    return `# yaml-language-server: $schema=https://sap.github.io/ui5-tooling/schema/ui5.yaml.json
specVersion: "3.1"
metadata:
  name: ${o.appName}
type: application
${framework}
`;
  }
  return `# yaml-language-server: $schema=https://sap.github.io/ui5-tooling/schema/ui5.yaml.json
specVersion: "3.1"
metadata:
  name: ${o.appName}
type: application
${framework}
server:
  customMiddleware:
    # mountPath belongs to the middleware entry, not to its configuration: inside configuration it
    # is ignored, the proxy mounts at / and answers for the app's own files too
    - name: ui5-middleware-simpleproxy
      afterMiddleware: compression
      mountPath: /sap
      configuration:
        baseUri: ""
`;
}

/**
 * The app's package.json.
 *
 * A standalone app owns its server, so it declares the UI5 CLI and the start scripts. An app inside
 * a CAP project does not: `cds watch` serves it, and a second toolchain there is noise. The members
 * are assembled as a list rather than interpolated around a comma, because the CAP branch used to
 * drop a bare `{}` where a member belonged and every generated CAP app shipped a package.json no
 * parser would read.
 */
export function fePackageJson(o: FeAppOptions, isCap: boolean): string {
  // members are joined with a comma and the indent the object uses
  const JOIN = `,
  `;
  const members = [
    `"name": "${o.appName}"`,
    `"version": "1.0.0"`,
    `"private": true`,
    `"description": "${o.description ?? o.title}"`
  ];
  if (!isCap) {
    members.push(
      `"scripts": {
    "start": "ui5 serve --open index.html",
    "start-mock": "ui5 serve --open index.html"
  }`,
      `"devDependencies": {
    "@ui5/cli": "^3",
    "ui5-middleware-simpleproxy": "^0.9"
  }`
    );
  }
  return `{
  ${members.join(JOIN)}
}
`;
}

export function feMetadataPlaceholder(): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<!-- Replace this placeholder with the real $metadata of your OData service:
     use the download_odata_service_metadata tool of sap-fiori-mcp-server. -->
<edmx:Edmx xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx" Version="4.0">
  <edmx:DataServices>
    <Schema xmlns="http://docs.oasis-open.org/odata/ns/edm" Namespace="placeholder">
      <EntityType Name="Placeholder">
        <Key><PropertyRef Name="ID"/></Key>
        <Property Name="ID" Type="Edm.String"/>
      </EntityType>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>
`;
}
