import type { DocEntry } from "../util/search.js";

/**
 * Fiori Elements / Fiori tools / OPA5 documentation corpus (English).
 * Compact, high-signal knowledge chunks used by the `search_docs` tool.
 */
export const fioriDocs: DocEntry[] = [
  {
    id: "fe-floorplans",
    corpus: "fiori",
    title: "SAP Fiori Elements floorplans overview",
    tags: ["list report", "object page", "worklist", "overview page", "floorplan"],
    body: `SAP Fiori Elements provides five main floorplans: List Report (search/filter/tabular data), Object Page (details of one entity instance with form sections and table facets), Work List (task-focused list), Overview Page (cards with KPIs and charts) and Analytical List Page (hybrid filter/chart/table). For OData V4 services use the V4 templates (sap.fe.templates.ListReport and sap.fe.templates.ObjectPage); for OData V2 use the V2 templates (sap.suite.ui.generic.template.ListReport and ObjectPage). Every floorplan is configured in manifest.json under sap.ui5/routing/targets with component settings: entitySet, variantManagement, navigation and controlConfiguration. The List Report shows the base entity in a smart table; row navigation goes to an Object Page based on the same entity. To-many associations of the object page entity become additional table facets.`
  },
  {
    id: "fe-manifest-lr",
    corpus: "fiori",
    title: "Configure a List Report target in manifest.json (V4)",
    tags: ["manifest", "routing", "entitySet", "sap.fe"],
    body: `In a Fiori elements V4 app the manifest sap.ui5 section defines rootView sap.fe.templates.ListReport.view.ListReport, model bound to an OData V4 dataSource, and routing targets of type Component. The List Report target: { "type": "Component", "id": "myList", "name": "sap.fe.templates.ListReport", "options": { "settings": { "entitySet": "Travel", "variantManagement": "Page", "navigation": { "Travel": { "detail": { "route": "TravelObjectPage" } } }, "initialLoad": true, "controlConfiguration": { "@com.sap.vocabularies.UI.v1.LineItem": { "tableSettings": { "type": "GridTable", "rowCountMode": "Auto" } } } } } }. initialLoad: true forces the table to load data immediately instead of waiting for the user to press Go.`
  },
  {
    id: "fe-fcl",
    corpus: "fiori",
    title: "Flexible Column Layout in Fiori elements",
    tags: ["FCL", "flexible column layout", "layout", "three columns"],
    body: `The Flexible Column Layout (FCL) shows up to three columns: list report, object page and another object page for a to-one or to-many navigation. To enable it: 1) add sap.ui.layout to manifest dependencies, 2) in routing config set "config": { "routerClass": "sap.f.routing.Router", "viewPath": ..., "controlId": "layout", "controlAggregation": "beginColumnPages" / "midColumnPages" / "endColumnPages" }, 3) add a sap.f.FlexibleColumnLayout as rootView (or use the generated App view), 4) add layouts mapping: "routing": { "routes": [...], "targets": {...} } plus "layouts": { "OneColumn": "OneColumn", "TwoColumnsMidExpanded": "TwoColumnsMidExpanded", "ThreeColumnsMidExpanded": "ThreeColumnsMidExpanded" } under sap.ui5/routing with the sap.f.FlexibleColumnLayoutSemanticHelper mapping. In Fiori elements V4 simply set manifest sap.ui5/routing/targets/*/controlAggregation and add "flexibleColumnLayout": { "defaultTwoColumnLayoutType": "TwoColumnsMidExpanded", "defaultThreeColumnLayoutType": "ThreeColumnsMidExpanded" } inside the App component settings.`
  },
  {
    id: "fe-annotations-ui",
    corpus: "fiori",
    title: "UI annotations for List Report and Object Page",
    tags: ["annotations", "@UI", "LineItem", "Identification", "Facets", "HeaderInfo"],
    body: `@UI annotations drive Fiori elements UI without code. Key terms: @UI.HeaderInfo (typeName, title, description shown on header), @UI.LineItem (table columns: valueQualifier, label, value, importance #HIGH/#MEDIUM/#LOW), @UI.Identification (Object Page form fields), @UI.Facets (sections: @UI.CollectionFacet, @UI.ReferenceFacet pointing to @UI.FieldGroup or a table via @UI.LineItem), @UI.FieldGroup (grouped form fields), @UI.SelectionFields (List Report filter bar fields), @UI.LineItem/FieldGroup with dataFieldDefaultInPlace. Example in CDS: annotate Travel with @(UI: { HeaderInfo: { TypeName: 'Travel', Title: { Value: TravelID } }, SelectionFields: [AgencyID, Status], LineItem: [{ Value: TravelID, Label: 'Travel' }, { Value: AgencyID }] }); In local annotations (XML): <Annotations Target="Namespace.EntityType"><Annotation Term="UI.LineItem">...`
  },
  {
    id: "fe-annotations-valuehelp",
    corpus: "fiori",
    title: "Value help and common annotations (@Common, @Consumption)",
    tags: ["value help", "value list", "@Common.ValueListWithFixedValues", "text arrangement"],
    body: `Value helps in Fiori elements come from metadata: @Common.ValueListWithFixedValues: true renders a dropdown; @Common.ValueList (V2) / @Consumption.Common.ValueListWithFixedValues plus @Common.ValueListRelevantQualifiers (V4) provide value help dialogs. Text arrangement: @Common.Text with @UI.TextArrangement: #TextOnly/#TextLast/#TextSeparate shows description next to key. Semantic keys: @Common.SemanticObject: 'Travel' enables smart link navigation. In CAP CDS: annotate element with @(Common: { Text: agency.name, TextArrangement: #TextOnly }, Consumption: { ValueHelpDerivation: ... }) or use @(Common.ValueList.v2: ...) for V2 services. Draft-enabled services automatically get value help for associations.`
  },
  {
    id: "fe-draft",
    corpus: "fiori",
    title: "Draft handling in Fiori elements",
    tags: ["draft", "edit draft", "SAP.CAP.draft", "enabled"],
    body: `Draft lets users edit data without locking. In CAP: entity Travel managed @(draft: enabled) { ... }. In RAP: behavior definition ... with draft;. The metadata exposes @Common.DraftRoot with ActivationAction/EditAction/EditRef. Fiori elements List Report/Object Page automatically render Edit/Delete/Create buttons and the 'My drafts' filter when draft annotations are present. For OData V4 the model settings in manifest should use "synchronizationMode": "None", "operationMode": "Server" and the app Component sap.fe.core.AppComponent. Non-draft apps need transaction handling via actions.`
  },
  {
    id: "fe-building-blocks",
    corpus: "fiori",
    title: "Fiori elements building blocks (custom sections and extensions)",
    tags: ["building block", "FilterBar", "Table", "Form", "custom section"],
    body: `Fiori elements V4 building blocks (sap.fe.macros) let you reuse FE controls in custom pages and extensions: <macros:FilterBar id="FB" metaPath="@com.sap.vocabularies.UI.v1.SelectionFields"/>, <macros:Table id="T" metaPath="@com.sap.vocabularies.UI.v1.LineItem"/>, <macros:Form id="F" metaPath="@com.sap.vocabularies.UI.v1.FieldGroup#Main"/>. Building blocks read the same annotations as standard FE pages, keep consistent look and behavior, and work in XML views inside custom sections. Add a custom section to an Object Page via manifest controlConfiguration or a view extension with target "TravelObjectPage" and action "afterRouting"/custom section fragment using macros:Section with title and content.`
  },
  {
    id: "fe-extensions",
    corpus: "fiori",
    title: "Extending Fiori elements apps: custom actions, columns, sections",
    tags: ["extension", "custom action", "custom column", "controller extension"],
    body: `Common Fiori elements extensions: 1) custom action on List Report/Object Page - annotate an unbound or bound action with @UI.lineItem: [{ type: #forAction, position: 10 }] so it renders automatically, or add a custom action via manifest "content": { "header": { "actions": { "MyAction": { "press": "my.namespace.ExtendContract", "text": "..." } } } }; 2) custom column in a table via controlConfiguration with "columns": { "CustomColumn": { "template": "my.Fragment", "position": 10 } } pointing to an XML fragment; 3) custom section on Object Page with macros:Section fragment registered in target settings "content" → "body" → "sections". Controller extensions use sap/ui/core/mvc/ControllerExtension with static overrides and are registered under "sap.ui5" → "extends" → "extensions" in manifest.json.`
  },
  {
    id: "fe-opa5",
    corpus: "opa5",
    title: "OPA5 test basics for Fiori apps",
    tags: ["opa5", "test", "integration", "QUnit"],
    body: `OPA5 (One Page Acceptance tests) drives a real UI5 app in a browser. Structure: webapp/test/integration/pages/ListReport.js with OPA5.extendConfig({ viewNamespace: "sap.fe.templates.", arrangements, actions, assertions }). A Journey: QUnit.module("List Report"); opaTest("should show travels", function(Given, When, Then) { Given.iStartMyFLPApp("fioriElements") or Given.iStartMyApp(); When.onTheListReportPage().iClickOnGo(); Then.onTheListReportPage().theTableHasItems(); Then.iTeardownMyApp(); }); Run with npm script "test-integration": "opa5" via karma or sap.fe.tests. Fiori elements provides predefined OPA5 pages (ListReport, ObjectPage) under sap/fe/test. Keep journeys small and independent; use mockserver in test suite for stability.`
  },
  {
    id: "fe-tools-preview",
    corpus: "fiori",
    title: "Previewing and testing Fiori apps locally",
    tags: ["preview", "cds watch", "ui5 serve", "mockserver", "npm run watch"],
    body: `To preview a CAP-based Fiori app run the most specific watch script of the app in the project package.json, e.g. "watch-travel": "cds watch --open travel/webapp/index.html?sap-client=100&sap-ui-xx-viewCache=false". For non-CAP (RAP) apps Fiori tools uses "start": "fiori run --open 'test/flpSandbox.html#travel-display'" which serves the app via ui5 and proxies to the configured destination; "start-local" uses the mockserver. In a plain setup use npx ui5 serve with a simple proxy middleware to your SAP system and open index.html. Always preview with the URL parameter sap-ui-xx-viewCache=false during development to avoid cached XML views.`
  },
  {
    id: "fe-adaptation",
    corpus: "fiori",
    title: "UI adaptation projects and app variants",
    tags: ["adaptation", "app variant", "key user", "RTA"],
    body: `An adaptation project (UI5 flexibility) modifies a standard SAP Fiori app without forking it: contains webapp/manifest.appdescr_variant with id, reference (original app id), layers (VENDOR/USER), and changes (changeDataSource, addXML, removeXML, addComponentUsages, changeAnnotationDataSource). Generate with @sap-ux/create 'adaptation-project', open with the editor, and the RTA (runtime adaptation) layer records key-user changes. Deployed variants are bound to the original app on the ABAP system; annotation changes reference a new annotation datasource added via changeAnnotationDataSource. Use the Fiori MCP server functionalities 'add_page', 'add_controller_extension' only for apps you own; adaptation projects use the variant manifest instead.`
  },
  {
    id: "fe-datamodel",
    corpus: "fiori",
    title: "Data model requirements for Fiori elements apps",
    tags: ["data model", "main entity", "association", "UUID", "keys"],
    body: `A Fiori elements application needs one main (base) entity plus to-one and to-many associations to related entities. Requirements: every entity has a primary key (UUID recommended, e.g. key ID : UUID;), every property has a proper CDS/EDM type (no typeless), to-many associations become table facets on the Object Page, to-one associations become value-helped input fields. When creating sample data CSV files all primary and foreign keys must be UUIDs (e.g. 550e8400-e29b-41d4-a716-446655440001). The service should expose projections with proper annotations; draft-enabled entities give edit flows. Avoid computed or read-only fields as inputs; use @readonly and mandatory flags to steer the UI.`
  },
  {
    id: "fe-manifest-datasources",
    corpus: "fiori",
    title: "manifest.json dataSources and models for OData V4/V2",
    tags: ["dataSource", "mainService", "odata", "model"],
    body: `Standard manifest sap.app/dataSources: { "mainService": { "uri": "/odata/v4/travel/", "type": "OData", "settings": { "odataVersion": "4.0", "annotations": ["annotation"] } }, "annotation": { "type": "ODataAnnotation", "uri": "annotations/annotation.xml", "settings": { "localUri": "annotations/annotation.xml" } } }. sap.ui5/models: { "i18n": { "type": "sap.ui.model.resource.ResourceModel", "settings": { "bundleName": "ns.app.i18n.i18n" } }, "": { "dataSource": "mainService", "preload": true, "settings": { "synchronizationMode": "None", "operationMode": "Server", "autoExpandSelect": true, "earlyRequests": true, "groupProperties": { "default": { "submit": "Auto" } } } } }. For V2 set odataVersion "2.0" and use ODataModel v2 settings (useBatch true, groupId/deferredGroups).`
  },
  {
    id: "fe-floorplan-selection",
    corpus: "fiori",
    title: "Choosing a floorplan for generate_fiori_app_odata/cap",
    tags: ["floorplan", "list-report", "object-page", "worklist", "analytical-list-page", "overview-page", "template"],
    body: `generate_fiori_app_odata and generate_fiori_app_cap support several floorplans: 'list-report' (search + tabular list + Object Page; OData V4 via sap.fe.templates and V2 via sap.suite.ui.generic.template — the default), 'object-page' (standalone Object Page / form entry, V4 only, rootView sap.fe.templates.ObjectPage.view.ObjectPage), 'worklist' (task-oriented List Report variant with initialLoad true and GridTable, V4+V2), 'analytical-list-page' (hybrid filter+chart+table, V2 only, sap.suite.ui.generic.template.AnalyticalListPage with sap.chart/sap.suite.ui.microchart) and 'overview-page' (card-based KPI overview, V2 only, sap.ovp with sap.ovp.cards.list cards configured under sap.ovp/cards). Unsupported floorplan/odataVersion combinations are auto-downgraded to 'list-report' with a warning. Flexible Column Layout (addFcl) applies to list-report and worklist only. After generation adjust the entitySet/serviceUri, download real metadata and use execute_functionality (add_page, add_controller_extension, enable_fcl, enable_initial_load, update_manifest) to modify.`
  }
];
