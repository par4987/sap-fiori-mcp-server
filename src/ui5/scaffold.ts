import path from "node:path";
import { resolvePath, writeFileSafe, exists } from "../util/fs.js";

export interface Ui5AppOptions {
  name: string; // folder + app name e.g. "shop"
  namespace: string; // e.g. "ns" → appId ns.shop
  title: string;
  template: "basic" | "worklist" | "master-detail" | "fcl" | "tabs";
  typescript?: boolean;
  serviceUri?: string; // for worklist/master-detail/fcl
  ui5Version?: string;
}

function appIdOf(namespace: string, name: string): string {
  const ns = (namespace || "ns").replace(/[^a-zA-Z0-9.]/g, "");
  return `${ns}.${name.replace(/[^a-zA-Z0-9]/g, "")}`;
}

export function ui5Manifest(o: Ui5AppOptions): string {
  const appId = appIdOf(o.namespace, o.name);
  const usesData = o.template !== "basic" && o.template !== "tabs";
  const entityPath = usesData ? "Products" : "";
  const routes =
    o.template === "basic"
      ? `"routes": [
        { "pattern": "", "name": "main", "target": "main" }
      ],
      "targets": {
        "main": { "viewName": "Main", "viewId": "main", "controlAggregation": "pages" }
      }`
      : o.template === "worklist"
        ? `"routes": [
        { "pattern": "", "name": "worklist", "target": "worklist" },
        { "pattern": "Products/{objectId}", "name": "object", "target": "object" }
      ],
      "targets": {
        "worklist": { "viewName": "Worklist", "viewId": "worklist", "controlAggregation": "pages" },
        "object": { "viewName": "Object", "viewId": "object", "controlAggregation": "pages" }
      }`
        : o.template === "master-detail"
          ? `"routes": [
        { "pattern": "", "name": "master", "target": "master" },
        { "pattern": "detail/{objectId}", "name": "detail", "target": "detail" }
      ],
      "targets": {
        "master": { "viewName": "Master", "viewId": "master", "controlAggregation": "pages" },
        "detail": { "viewName": "Detail", "viewId": "detail", "controlAggregation": "pages" }
      }`
          : o.template === "fcl"
            ? `"routes": [
        { "pattern": "", "name": "master", "target": "master" },
        { "pattern": "detail/{objectId}", "name": "detail", "target": "detail" }
      ],
      "targets": {
        "master": { "viewName": "Master", "viewId": "master", "controlAggregation": "beginColumnPages" },
        "detail": { "viewName": "Detail", "viewId": "detail", "controlAggregation": "midColumnPages" }
      }`
            : `"routes": [
        { "pattern": "", "name": "main", "target": "main" }
      ],
      "targets": {
        "main": { "viewName": "Main", "viewId": "main", "controlAggregation": "pages" }
      }`;
  const usesFcl = o.template === "fcl" || o.template === "master-detail";
  const odataModel =
    !usesData
      ? ""
      : `,
      "": {
        "dataSource": "mainService",
        "preload": true,
        "settings": {
          "odataVersion": "2.0",
          "useBatch": true
        }
      }`;
  const dataSources =
    !usesData
      ? ""
      : `,
    "dataSources": {
      "mainService": {
        "uri": "${o.serviceUri ?? "/here/goes/your/serviceurl/"}",
        "type": "OData",
        "settings": { "odataVersion": "2.0", "localUri": "localService/metadata.xml" }
      }
    }`;

  return `{
  "_version": "1.65.0",
  "sap.app": {
    "id": "${appId}",
    "type": "application",
    "i18n": "i18n/i18n.properties",
    "applicationVersion": { "version": "1.0.0" },
    "title": "{{appTitle}}",
    "description": "{{appDescription}}"${dataSources},
    "sourceTemplate": { "id": "sap-fiori-mcp-server.ui5-${o.template}", "version": "1.0.0" }
  },
  "sap.ui": {
    "technology": "UI5",
    "deviceTypes": { "desktop": true, "tablet": true, "phone": true }
  },
  "sap.ui5": {
    "flexEnabled": false,
    "rootView": {
      "viewName": "${appId}.view.App",
      "type": "XML",
      "async": true,
      "id": "app"
    },
    "dependencies": {
      "minUI5Version": "${o.ui5Version ?? "1.120.0"}",
      "libs": { "sap.m": {}, "sap.ui.core": {},${usesFcl ? ' "sap.f": {},' : ""} "sap.ui.layout": {} }
    },
    "models": {
      "i18n": {
        "type": "sap.ui.model.resource.ResourceModel",
        "settings": { "bundleName": "${appId}.i18n.i18n" }
      }${odataModel}
    },
    "routing": {
      "config": {
        "routerClass": "${usesFcl ? "sap.f.routing.Router" : "sap.m.routing.Router"}",
        "viewType": "XML",
        "async": true,
        "viewPath": "${appId}.view",
        "controlId": "${o.template === "fcl" ? "layout" : "app"}",
        "controlAggregation": "${o.template === "fcl" ? "beginColumnPages" : "pages"}",
        "clearControlAggregation": false
      },
      ${routes}
    }
  }
}
`;
}

export function ui5ComponentJs(o: Ui5AppOptions): string {
  return `sap.ui.define([
  "sap/ui/core/UIComponent",
  "${appIdOf(o.namespace, o.name)}/model/models"
], function (UIComponent, models) {
  "use strict";

  return UIComponent.extend("${appIdOf(o.namespace, o.name)}.Component", {
    metadata: { manifest: "json" },

    init: function () {
      UIComponent.prototype.init.apply(this, arguments);
      this.setModel(models.createDeviceModel(), "device");
      this.getRouter().initialize();
    }
  });
});
`;
}

export function ui5AppView(o: Ui5AppOptions): string {
  if (o.template === "master-detail" || o.template === "fcl") {
    return `<mvc:View xmlns:mvc="sap.ui.core.mvc" xmlns:f="sap.f" displayBlock="true">
  <f:FlexibleColumnLayout id="layout" layout="TwoColumnsMidExpanded">
    <f:beginColumnPages>
      <mvc:XMLView id="master" viewName="${appIdOf(o.namespace, o.name)}.view.Master"/>
    </f:beginColumnPages>
    <f:midColumnPages>
      <mvc:XMLView id="detail" viewName="${appIdOf(o.namespace, o.name)}.view.Detail"/>
    </f:midColumnPages>
  </f:FlexibleColumnLayout>
</mvc:View>
`;
  }
  return `<mvc:View xmlns:mvc="sap.ui.core.mvc" xmlns="sap.m" displayBlock="true">
  <App id="app"/>
</mvc:View>
`;
}

export function ui5AppController(o: Ui5AppOptions): string {
  return `sap.ui.define(["sap/ui/core/mvc/Controller"], function (Controller) {
  "use strict";

  return Controller.extend("${appIdOf(o.namespace, o.name)}.controller.App", {
    onInit: function () {}
  });
});
`;
}

export function ui5MainView(o: Ui5AppOptions): { name: string; content: string }[] {
  const appId = appIdOf(o.namespace, o.name);
  if (o.template === "basic") {
    return [
      {
        name: "view/Main.view.xml",
        content: `<mvc:View xmlns:mvc="sap.ui.core.mvc" xmlns="sap.m" controllerName="${appId}.controller.Main" displayBlock="true">
  <Page id="mainPage" title="{i18n>appTitle}">
    <content>
      <VBox class="sapUiSmallMargin">
        <Title text="{i18n>welcomeTitle}" titleStyle="H2"/>
        <Text text="{i18n>welcomeText}" wrapping="true"/>
        <Button text="{i18n>sayHello}" press=".onSayHello" class="sapUiTinyMarginTop" type="Emphasized"/>
      </VBox>
    </content>
  </Page>
</mvc:View>
`
      },
      {
        name: "view/Main.controller.js",
        content: `sap.ui.define(["sap/ui/core/mvc/Controller", "sap/m/MessageToast"], function (Controller, MessageToast) {
  "use strict";

  return Controller.extend("${appId}.controller.Main", {
    onSayHello: function () {
      MessageToast.show(this.getOwnerComponent().getModel("i18n").getResourceBundle().getText("helloMessage"));
    }
  });
});
`
      }
    ];
  }
  const entity = "Products";
  const listColumns = `<columns>
        <Column header="{i18n>nameColumn}"><Text text="{Name}"/></Column>
        <Column header="{i18n>priceColumn}" hAlign="End"><Text text="{Price}"/></Column>
      </columns>`;
  const listItems = `<StandardListItem title="{Name}" description="{Description}" type="Navigation" press=".onItemPress"/>`;
  if (o.template === "tabs") {
    return [
      {
        name: "view/Main.view.xml",
        content: `<mvc:View xmlns:mvc="sap.ui.core.mvc" xmlns="sap.m" controllerName="${appId}.controller.Main" displayBlock="true">
  <Page id="mainPage" title="{i18n>appTitle}">
    <content>
      <IconTabBar id="tabBar" expanded="true" select=".onTabSelect">
        <items>
          <IconTabFilter icon="sap-icon://hello-world" text="{i18n>tabOverview}" key="overview">
            <Text text="{i18n>welcomeText}" wrapping="true" class="sapUiSmallMargin"/>
          </IconTabFilter>
          <IconTabFilter icon="sap-icon://list" text="{i18n>tabData}" key="data">
            <VBox class="sapUiSmallMargin">
              <Label text="{i18n>nameColumn}"/><Text text="{i18n>dataHint}" wrapping="true"/>
            </VBox>
          </IconTabFilter>
          <IconTabFilter icon="sap-icon://information" text="{i18n>tabAbout}" key="about">
            <Text text="{i18n>aboutText}" wrapping="true" class="sapUiSmallMargin"/>
          </IconTabFilter>
        </items>
      </IconTabBar>
    </content>
  </Page>
</mvc:View>
`
      },
      {
        name: "view/Main.controller.js",
        content: `sap.ui.define(["sap/ui/core/mvc/Controller", "sap/m/MessageToast"], function (Controller, MessageToast) {
  "use strict";

  return Controller.extend("${appId}.controller.Main", {
    onTabSelect: function (oEvent) {
      MessageToast.show(oEvent.getParameter("key"));
    }
  });
});
`
      }
    ];
  }
  if (o.template === "worklist") {
    return [
      {
        name: "view/Worklist.view.xml",
        content: `<mvc:View xmlns:mvc="sap.ui.core.mvc" xmlns="sap.m" controllerName="${appId}.controller.Worklist">
  <Page id="worklistPage" title="{i18n>appTitle}" showNavButton="false">
    <subHeader>
      <Toolbar>
        <SearchField search=".onSearch" width="100%"/>
      </Toolbar>
    </subHeader>
    <content>
      <Table id="list" items="{ path: '/${entity}', parameters: { expand: 'Category' } }" growing="true" growingThreshold="20" inset="false">
        <headerToolbar><Toolbar><content><Title text="{i18n>worklistTitle}"/></content></Toolbar></headerToolbar>
        ${listColumns}
        <items><ColumnListItem vAlign="Middle" type="Navigation" press=".onItemPress">${listItems}</ColumnListItem></items>
      </Table>
    </content>
  </Page>
</mvc:View>
`
      },
      {
        name: "view/Worklist.controller.js",
        content: `sap.ui.define(["sap/ui/core/mvc/Controller", "sap/ui/model/Filter", "sap/ui/model/FilterOperator"], function (Controller, Filter, FilterOperator) {
  "use strict";

  return Controller.extend("${appId}.controller.Worklist", {
    onSearch: function (oEvent) {
      const query = oEvent.getSource().getValue();
      const binding = this.byId("list").getBinding("items");
      binding.filter(query ? [new Filter("Name", FilterOperator.Contains, query)] : []);
    },
    onItemPress: function (oEvent) {
      this.getRouter().navTo("object", { objectId: oEvent.getSource().getBindingContext().getProperty("ID") });
    },
    getRouter: function () {
      return this.getOwnerComponent().getRouter();
    }
  });
});
`
      },
      {
        name: "view/Object.view.xml",
        content: `<mvc:View xmlns:mvc="sap.ui.core.mvc" xmlns="sap.m" controllerName="${appId}.controller.Object">
  <Page id="objectPage" title="{i18n>objectTitle}" showNavButton="true" navButtonPress=".onNavBack">
    <content>
      <VBox class="sapUiSmallMargin">
        <Label text="{i18n>nameColumn}"/><Text text="{Name}"/>
        <Label text="{i18n>priceColumn}"/><Text text="{Price}"/>
      </VBox>
    </content>
  </Page>
</mvc:View>
`
      },
      {
        name: "view/Object.controller.js",
        content: `sap.ui.define(["sap/ui/core/mvc/Controller"], function (Controller) {
  "use strict";

  return Controller.extend("${appId}.controller.Object", {
    onNavBack: function () {
      history.go(-1);
    }
  });
});
`
      }
    ];
  }
  // master-detail and fcl share the Master/Detail page views (the difference is the App view + routing)
  return [
    {
      name: "view/Master.view.xml",
      content: `<mvc:View xmlns:mvc="sap.ui.core.mvc" xmlns="sap.m" controllerName="${appId}.controller.Master">
  <Page id="masterPage" title="{i18n>worklistTitle}">
    <content>
      <List id="list" items="{ path: '/${entity}' }" mode="SingleSelectMaster" selectionChange=".onSelect">
        ${listItems}
      </List>
    </content>
  </Page>
</mvc:View>
`
    },
    {
      name: "view/Master.controller.js",
      content: `sap.ui.define(["sap/ui/core/mvc/Controller"], function (Controller) {
  "use strict";

  return Controller.extend("${appId}.controller.Master", {
    onSelect: function (oEvent) {
      this.getRouter().navTo("detail", { objectId: oEvent.getSource().getBindingContext().getProperty("ID") });
    },
    getRouter: function () {
      return this.getOwnerComponent().getRouter();
    }
  });
});
`
    },
    {
      name: "view/Detail.view.xml",
      content: `<mvc:View xmlns:mvc="sap.ui.core.mvc" xmlns="sap.m" controllerName="${appId}.controller.Detail">
  <Page id="detailPage" title="{i18n>objectTitle}">
    <content>
      <VBox class="sapUiSmallMargin">
        <Label text="{i18n>nameColumn}"/><Text text="{Name}"/>
      </VBox>
    </content>
  </Page>
</mvc:View>
`
    },
    {
      name: "view/Detail.controller.js",
      content: `sap.ui.define(["sap/ui/core/mvc/Controller"], function (Controller) {
  "use strict";

  return Controller.extend("${appId}.controller.Detail", {
    onInit: function () {
      this.getRouter().getRoute("detail").attachPatternMatched(this._onMatched, this);
    },
    _onMatched: function (oEvent) {
      this.getView().bindElement({ path: "/" + decodeURIComponent(oEvent.getParameter("arguments").objectId) });
    }
  });
});
`
    }
  ];
}

export function ui5ModelsJs(o: Ui5AppOptions): string {
  return `sap.ui.define(["sap/ui/model/json/JSONModel", "sap/ui/Device"], function (JSONModel, Device) {
  "use strict";

  return {
    createDeviceModel: function () {
      const oModel = new JSONModel(Device);
      oModel.setDefaultBindingMode("OneWay");
      return oModel;
    }
  };
});
`;
}

export function ui5I18n(o: Ui5AppOptions): string {
  if (o.template === "basic" || o.template === "tabs") {
    const tabsKeys =
      o.template === "tabs"
        ? `
tabOverview=Overview
tabData=Data
tabAbout=About
dataHint=Bind this section to your OData model or JSONModel.
aboutText=Generated by sap-fiori-mcp-server (tabs template).
`
        : "";
    return `appTitle=${o.title}
appDescription=${o.title}

welcomeTitle=Welcome to ${o.title}
welcomeText=This app was generated by sap-fiori-mcp-server. Start editing view/Main.view.xml and controller/Main.controller.js.
sayHello=Say hello
helloMessage=Hello! Your UI5 app is running.${tabsKeys}
`;
  }
  return `appTitle=${o.title}
appDescription=${o.title}
worklistTitle=Worklist
objectTitle=Details
nameColumn=Name
priceColumn=Price
`;
}

export function ui5IndexHtml(o: Ui5AppOptions): string {
  const appId = appIdOf(o.namespace, o.name);
  const libs = o.template === "master-detail" || o.template === "fcl" ? "sap.m, sap.f" : "sap.m";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${o.title}</title>
  <script id="sap-ui-bootstrap"
    src="https://sdk.openui5.org/${o.ui5Version ?? "1.120.0"}/resources/sap-ui-core.js"
    data-sap-ui-theme="sap_horizon"
    data-sap-ui-compat-version="edge"
    data-sap-ui-libraries="${libs}"
    data-sap-ui-async="true"
    data-sap-ui-resourceroots='{ "${appId}": "./" }'>
  </script>
  <link rel="stylesheet" type="text/css" href="css/style.css">
</head>
<body class="sapUiBody" id="content">
  <div data-sap-ui-component data-sap-ui-component-name="${appId}" id="root"></div>
</body>
</html>
`;
}

export function createUi5App(targetPath: string, o: Ui5AppOptions): { appPath: string; files: string[] } {
  const root = resolvePath(targetPath);
  const folder = o.name.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase();
  const appPath = path.join(root, folder);
  if (exists(appPath)) throw new Error(`Target app folder already exists: ${appPath}`);

  const files: Record<string, string> = {
    "webapp/manifest.json": ui5Manifest(o),
    "webapp/Component.js": ui5ComponentJs(o),
    "webapp/index.html": ui5IndexHtml(o),
    "webapp/i18n/i18n.properties": ui5I18n(o),
    "webapp/model/models.js": ui5ModelsJs(o),
    "webapp/view/App.view.xml": ui5AppView(o),
    "webapp/view/App.controller.js": ui5AppController(o),
    "webapp/css/style.css": "/* custom styles */\n",
    "package.json": JSON.stringify(
      {
        name: folder,
        version: "1.0.0",
        private: true,
        scripts: { start: "ui5 serve --open index.html" },
        devDependencies: { "@ui5/cli": "^3" }
      },
      null,
      2
    ) + "\n",
    "ui5.yaml": `specVersion: "3.1"
metadata:
  name: ${folder}
type: application
framework:
  name: OpenUI5
  version: "${o.ui5Version ?? "1.120.0"}"
`
  };
  for (const view of ui5MainView(o)) {
    files[`webapp/${view.name}`] = view.content;
  }

  const created: string[] = [];
  for (const [rel, content] of Object.entries(files)) {
    writeFileSafe(path.join(appPath, rel), content);
    created.push(path.join(appPath, rel));
  }
  return { appPath, files: created };
}

export function createIntegrationCard(targetPath: string, o: { name: string; cardType: string; title?: string; namespace?: string; dataUrl?: string }): { appPath: string; files: string[] } {
  const root = resolvePath(targetPath);
  const folder = o.name.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase();
  const appPath = path.join(root, folder);
  if (exists(appPath)) throw new Error(`Target card folder already exists: ${appPath}`);
  const appId = `${(o.namespace || "ns").replace(/[^a-zA-Z0-9.]/g, "") || "ns"}.${folder}`;

  const dataUrl = o.dataUrl ?? "https://services.odata.org/V2/Northwind/Northwind.svc/Products?$format=json&$top=5";
  const contentByType: Record<string, string> = {
    List: `"content": {
      "data": { "request": { "url": "${dataUrl}" }, "path": "d/results" },
      "item": {
        "title": "{ProductName}",
        "description": "{QuantityPerUnit}",
        "info": "{Discontinued === 'true' ? 'Discontinued' : 'Available'}"
      }
    }`,
    Object: `"content": {
      "data": { "request": { "url": "${dataUrl}" }, "path": "d/results/0" },
      "mainAttribute": { "value": "{ProductName}" },
      "attributes": [
        { "label": "Unit price", "value": "{UnitPrice}" },
        { "label": "Units in stock", "value": "{UnitsInStock}" }
      ]
    }`,
    Table: `"content": {
      "data": { "request": { "url": "${dataUrl}" }, "path": "d/results" },
      "row": {
        "cells": [
          { "columnId": "name", "value": "{ProductName}" },
          { "columnId": "price", "value": "{UnitPrice}" }
        ]
      },
      "columns": [
        { "id": "name", "label": "Product" },
        { "id": "price", "label": "Price" }
      ]
    }`,
    Timeline: `"content": {
      "data": { "request": { "url": "${dataUrl}" }, "path": "d/results" },
      "item": { "title": "{ProductName}", "dateTime": { "value": "{OrderDate}" }, "userName": "{ContactName}" }
    }`,
    Analytical: `"content": {
      "data": { "request": { "url": "${dataUrl}" }, "path": "d/results" },
      "chart": { "chartType": "bar", "dimensions": ["ProductName"], "measures": ["UnitPrice"] }
    }`,
    Component: `"content": { "useApproverComponent": true }`,
    Adaptive: `"content": {
      "type": "AdaptiveCard",
      "version": "1.0",
      "body": [{ "type": "TextBlock", "text": "{ProductName}" }]
    }`,
    Calendar: `"content": { "data": { "request": { "url": "${dataUrl}" } } }`
  };

  const manifest = `{
  "_version": "1.65.0",
  "sap.app": {
    "id": "${appId}",
    "type": "card",
    "i18n": "i18n/i18n.properties",
    "applicationVersion": { "version": "1.0.0" },
    "title": "${o.title ?? o.name}",
    "description": "Integration card generated by sap-fiori-mcp-server"
  },
  "sap.card": {
    "type": "${o.cardType}",
    "header": {
      "type": "Numeric",
      "title": "${o.title ?? o.name}",
      "subtitle": "Sample card",
      "data": { "request": { "url": "${dataUrl}" }, "path": "d/results" },
      "mainIndicator": { "number": "{length(path)}", "unit": "items" }
    },
    ${contentByType[o.cardType] ?? contentByType["List"]}
  }
}
`;

  const files: Record<string, string> = {
    "webapp/manifest.json": manifest,
    "webapp/i18n/i18n.properties": `cardTitle=${o.title ?? o.name}\n`,
    "index.html": `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${o.title ?? o.name} — card preview</title>
  <script id="sap-ui-bootstrap"
    src="https://sdk.openui5.org/resources/sap-ui-core.js"
    data-sap-ui-theme="sap_horizon"
    data-sap-ui-async="true"
    data-sap-ui-libs="sap.ui.integration">
  </script>
</head>
<body class="sapUiBody">
  <div class="cardPreview" style="width:400px;margin:2rem auto;">
    <div data-sap-ui-card src="./webapp/manifest.json"></div>
  </div>
</body>
</html>
`
  };
  const created: string[] = [];
  for (const [rel, content] of Object.entries(files)) {
    writeFileSafe(path.join(appPath, rel), content);
    created.push(path.join(appPath, rel));
  }
  return { appPath, files: created };
}
