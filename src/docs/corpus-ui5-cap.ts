import type { DocEntry } from "../util/search.js";

/** UI5, Integration Cards and TypeScript-conversion documentation corpus. */
export const ui5Docs: DocEntry[] = [
  {
    id: "ui5-mvc",
    corpus: "ui5",
    title: "UI5 MVC basics: views, controllers, models",
    tags: ["MVC", "XML view", "controller", "model"],
    body: `UI5 follows MVC: XML views declare the UI (default namespace xmlns="sap.m", core xmlns:core="sap.ui.core"), controllers (sap.ui.core.mvc.Controller) contain event handlers and lifecycle hooks (onInit, onBeforeRendering, onAfterRendering, onExit), models hold data (ODataModel for services, JSONModel for local data, ResourceModel for i18n). Bind views with a component model: this.getView().setModel(oModel) or in manifest.json under sap.ui5/models. Routing is configured in manifest.json sap.ui5/routing with routes (pattern, target) and targets (viewName, controlId, controlAggregation). Use this.getRouter().navTo("detail", { contextPath: ... }) in controllers and ownerComponent().getRouter() for access.`
  },
  {
    id: "ui5-bindings",
    corpus: "ui5",
    title: "Data binding syntax: property, aggregation, expression, absolute/relative",
    tags: ["binding", "{path}", "parts", "formatter", "aggregation"],
    body: `Bindings: property binding text="{/firstName}" or "{i18n>saveBtn}", aggregation binding items="{ path: '/Products', sorter: [{ path: 'Name' }], parameters: { expand: 'Category' } }", element binding in ObjectPage context this.getView().bindElement({ path: '/Products(1)', parameters: { expand: 'Category' } }). Expression binding: visible="{= \${status} === 'A' }". Parts with formatter: text="{ parts: [{path: 'price'}, {path: 'currency'}], formatter: '.formatPrice' }" where formatPrice is a controller method. Relative bindings resolve against the parent context; absolute start with '/'. For OData V4 prefer path binding with $$updateGroupId and two-way when the model allows it.`
  },
  {
    id: "ui5-controls",
    corpus: "ui5",
    title: "Common sap.m controls for tables, forms and dialogs",
    tags: ["Table", "List", "SmartTable", "Form", "Dialog", "UploadSet"],
    body: `Tables: sap.m.Table (responsive, items aggregation with ColumnListItem), sap.m.TreeTable and sap.ui.table.Table (desktop grid, rows aggregation), sap.ui.mdc.Table and building-block Table for Fiori elements. Lists: sap.m.List with StandardListItem/InputListItem. Forms: sap.ui.layout.form.SimpleForm or smart Form (sap.ui.comp.smartform.SmartForm with SmartField). Dialogs: sap.m.Dialog with begin/end buttons, MessageBox for confirmations. Uploads: sap.m.upload.UploadSet. Fragments (sap/ui/core/Fragment.load) reuse dialogs and form parts; give fragments stable ids via fragment id parameter. Prefer typed controllers and avoid direct DOM manipulation.`
  },
  {
    id: "ui5-i18n",
    corpus: "ui5",
    title: "Internationalization (i18n) in UI5",
    tags: ["i18n", "resource model", "properties", "RTL"],
    body: `Declare the i18n model in manifest.json: "models": { "i18n": { "type": "sap.ui.model.resource.ResourceModel", "settings": { "bundleName": "my.namespace.i18n.i18n", "supportedLocales": ["", "de", "es"], "fallbackLocale": "en" } } }. In views: text="{i18n>save}" ; in controllers: this.getOwnerComponent().getModel("i18n").getResourceBundle().getText("save"). Provide i18n.properties (default), plus i18n_de.properties etc. Never hardcode user-facing strings in views/controllers; use placeholders {0} in texts and pass arguments. Set app title via sap.app/title and describe translations in sap.app/i18n "bundledLocales". UI5 automatically handles right-to-left languages and date/number formatting via sap.ui.core.LocaleData.`
  },
  {
    id: "ui5-routing",
    corpus: "ui5",
    title: "Routing and navigation in manifest.json",
    tags: ["routing", "routes", "targets", "navTo", "hash"],
    body: `manifest sap.ui5/routing: "config": { "routerClass": "sap.m.routing.Router", "viewType": "XML", "async": true, "viewPath": "my.ns.app.view", "controlId": "app", "controlAggregation": "pages", "clearControlAggregation": false }, "routes": [{ "pattern": "", "name": "main", "target": "main" }, { "pattern": "detail/{productId}", "name": "detail", "target": "detail" }], "targets": { "main": { "viewName": "Main", "viewId": "main" }, "detail": { "viewName": "Detail", "viewId": "detail" } }. In App.view.xml use <App id="app"> from sap.m. Navigate: this.getRouter().navTo("detail", { productId: id }); listen: getRouter().attachRoutePatternMatched. Use hash-based navigation with sap.m.routing.RouteMatchedInfo; targets can be nested with subroutes. Always set "async": true for modern apps.`
  },
  {
    id: "ui5-manifest-schema",
    corpus: "ui5",
    title: "manifest.json structure and validation rules",
    tags: ["manifest", "sap.app", "sap.ui", "sap.ui5", "validation"],
    body: `manifest.json has three main namespaces: sap.app (id: reverse-domain namespace unique and matching the package structure, type: application|card|component|library|theme-package, i18n, applicationVersion, title, description, dataSources, embeddedBy, crossNavigation), sap.ui (technology: UI5, icons, deviceTypes, supportedThemes) and sap.ui5 (rootView, dependencies: { minUI5Version, libs: { "sap.m": {} } }, models, routing, resources, content, extends/extensions, componentUsages, flexEnabled: true). Validation checks: id must not contain underscores or start with a digit, must be reverse domain; all dataSources referenced by models must exist; routing targets referenced by routes must be defined; rootView.viewName must resolve to an existing XML view file; minUI5Version must be a valid version; JSON must not contain comments or trailing commas.`
  },
  {
    id: "ui5-guidelines-general",
    corpus: "ui5",
    title: "UI5 development best practices",
    tags: ["best practices", "async", "fragment", "deprecation", "security"],
    body: `Best practices: 1) use async loading everywhere (async views, Fragment.load, Controller.loadFragment); 2) no global variables - use sap.ui.define AMD modules with exact dependency paths; 3) prefer XML views over JS views; 4) use typed models and two-way binding only where meaningful; 5) keep controllers lean, extract formatters/models into separate modules; 6) avoid deprecated APIs (jQuery.sap.*, sap.ui.getCore().byId in controllers, sap.ui.commons); use sap/ui/core/Lib or byId via view; 7) i18n for every visible text; 8) stable ids: use id prefixes and this.byId() instead of jQuery/strict DOM access; 9) security: escape user input, no eval, set CSP headers, avoid innerHTML; 10) performance: use aggregation binding with growing/deferred requests, minimize control count, enable preprocessors only when needed; 11) use sap.ui.core.mvc.ViewType.XML and modularize with fragments; 12) test with QUnit + OPA5.`
  },
  {
    id: "ui5-typescript",
    corpus: "typescript",
    title: "Converting UI5 apps from JavaScript to TypeScript",
    tags: ["typescript", "conversion", "d.ts", "ControllerExtension"],
    body: `Steps to convert a UI5 app to TypeScript: 1) add devDependencies @types/openui5 or @sapui5/ts-types-esm, typescript, ui5-tooling-transpile; 2) create tsconfig.json with target ES2022, module ES2022 (or amd via transpile), strict: true, types: ["@types/openui5"]; 3) rename .js controllers to .ts, import classes: import Controller from "sap/ui/core/mvc/Controller"; import JSONModel from "sap/ui/model/json/JSONModel"; class Main extends Controller { onInit(): void { ... } } export default Main; 4) type models: (this.getView()!.getModel() as ODataModel); 5) XML views stay unchanged, manifest references "*.Main" component path; 6) enable build: ui5.yaml custom task ui5-tooling-transpile-task with replacePatterns, or use @ui5/ts-interface-generator to generate UI5-compatible descriptors; 7) keep AMD style: set "module": "ES2022" and transpile with the task; avoid default-require mixing. Controller extensions (FE) extend ControllerExtension with static overrides typed via @ui5/fe.`
  },
  {
    id: "ui5-cards",
    corpus: "cards",
    title: "UI Integration Cards overview and types",
    tags: ["integration card", "manifest", "sap.card", "adaptive", "list", "table"],
    body: `UI Integration Cards are lightweight, manifest-driven widgets for SAP Build Work Zone / Launchpad. Card types: Adaptive (schema.org), Analytical (chart), Calendar, Component (custom UI5 component), List (items with title/description/info), Object (single object with attributes and indicators), Table (tabular data), Timeline (feed entries). A card manifest.json: sap.app { id, type: "card", title }, sap.card { type: "List", header: { title, type: "Numeric" }, content: { data: { request: { url: "/odata/..." } }, item: { title: "{name}", description: "{desc}", info: "{status}" } } }. Preview with index.html loading sap/ui/integration/designtime/api or https://ui5.sap.com/test-resources/sap/ui/integration/demokit/cardExplorer/webapp/index.html. Data binding uses {} placeholders against the JSON/OData response.`
  },
  {
    id: "ui5-versions",
    corpus: "ui5",
    title: "UI5 versions and long-term maintenance",
    tags: ["version", "1.108", "1.120", "maintenance", "minUI5Version"],
    body: `UI5 versions: monthly minor releases (e.g. 1.120, 1.130, 1.140, 1.152 for OpenUI5 nightly), every second minor is an LTS/maintenance version (e.g. 1.108, 1.120, 1.136). Check https://ui5.sap.com/versionoverview.html. Set "minUI5Version" in manifest sap.ui5/dependencies; align your bootstrap with the same version: <script src="https://ui5.sap.com/1.120.0/resources/sap-ui-core.js">. For Fiori elements V4 use a recent minor >= 1.108 with sap.fe. The sap-ui-version.json endpoint on the CDN exposes the exact version and library versions of a distribution - the get_version_info tool reads it. Pin versions in package.json (@sapui5/ts-types-esm) and ui5.yaml framework.version for builds.`
  }
];

/** CAP documentation corpus (CDS, services, handlers, deployment). */
export const capDocs: DocEntry[] = [
  {
    id: "cap-cds-basics",
    corpus: "cap",
    title: "CDS basics: entities, types, associations",
    tags: ["cds", "entity", "aspect", "type", "association"],
    body: `CDS models live in db/ and srv/ as .cds files. Define: namespace my.bookshop; using { Currency, cuid, managed } from '@sap/cds/common'; entity Books : managed { key ID : UUID; title : String(111); stock : Integer; price : Decimal(9,2); author : Association to Authors; genre : Association to Genres; } entity Authors : managed { key ID : UUID; name : String; books : Association to many Books on books.author = $self; }. Common types from @sap/cds/common: cuid (key ID : UUID), managed (createdAt, createdBy, modifiedAt, modifiedBy), temporal, Country/Currency/Language. Aspects add reusable fields: entity X : managed, my.custom.Aspect {}. Compositions (Composition of many Items) model containment with cascading delete.`
  },
  {
    id: "cap-services",
    corpus: "cap",
    title: "Services: projections, exposure and annotations",
    tags: ["service", "projection", "exposure", "draft", "readonly"],
    body: `Services are the API layer in srv/: service CatalogService @(path:'/browse') { @readonly entity Books as projection on my.Books { *, author.name as author } @restrict: [{ grant: 'READ' }] action submitOrder(book: Books:ID, quantity: Integer) returns Decimal; }. Entities exposed as projections become OData entity sets at /odata/v4/browse/Books. Aspects: @(requires: 'authenticated-users') service AdminService @(path:'/admin') { entity Books as projection on my.Books; }. Draft: @(draft: enabled) on the projection. Auto-exposure: entities in the service body automatically become entity sets; use 'as projection on' to rename, 'as select from' with a { } column list for restrictions. CQL supports where clauses in projections: entity BestSellers as select from my.Books where stock > 0.`
  },
  {
    id: "cap-handlers",
    corpus: "cap",
    title: "Custom handlers in CAP Node.js",
    tags: ["handler", "before", "after", "on", "cds.serve", "req", "custom logic"],
    body: `Custom logic lives in srv/*.js matched by service name: const cds = require('@sap/cds'); module.exports = class CatalogService extends cds.ApplicationService { init() { const { Books } = cds.entities('my.bookshop'); this.before('READ', Books, req => req.query.where({ stock: {'>': 0} })); this.after('each', Books, book => book.title = book.title.toUpperCase()); this.on('submitOrder', async req => { const { book, quantity } = req.data; ... return total; }); return super.init(); } }. Handler phases: before (validate/modify req), on (replace default), after (transform results). tx/transaction: const { Books } = srv.entities; await INSERT.into(Books).entries(...); UPDATE(Books, id).with({ stock: stock -= qty }); req.error(409, 'Out of stock') for errors; req.info/warn. Use cds.test() to run integration tests with jest/mocha.`
  },
  {
    id: "cap-data",
    corpus: "cap",
    title: "CAP sample data with CSV files",
    tags: ["csv", "sample data", "db/data", "mock"],
    body: `CAP loads sample data from CSV files in db/data/ (configurable via cds.data... or db/csv). File naming convention: <namespace>-<Entity>.csv, e.g. my.bookshop-Books.csv for namespace my.bookshop entity Books. First row is the header with column names (optionally ' as ' aliases), subsequent rows the data: ID,title,stock\n1,Cat,12. Values are typed automatically by the model; dates as ISO strings, booleans true/false. Keys: UUIDs recommended (e.g. 550e8400-e29b-41d4-a716-446655440001). The CSV files are used by the in-memory database (SQLite) on cds watch; insert order matters for associations. With cds deploy --to sqlite:db.sqlite the data is persisted. For HANA, CSVs can be used via hdi deployment as well.`
  },
  {
    id: "cap-auth",
    corpus: "cap",
    title: "Authorization in CAP: @restrict, roles, XSUAA",
    tags: ["auth", "restrict", "requires", "roles", "xsuaa"],
    body: `Declarative auth: entity Books @(restrict: [{ grant: ['READ', 'WRITE'], to: 'admin' }, { grant: 'READ', where: 'createdBy = $user' }]) {}; service AdminService @(requires: 'admin'); action ... @(requires: 'CatalogAdmin'). Roles map to XSUAA scopes in the mtiaas/xsuaa configuration: scope names $XSAPPNAME.admin. For local dev the mocked auth accepts users defined in package.json cds.requires.auth.users (e.g. alice with admin role, credentials { password: '' }), tested via basic auth on cds watch: http://alice@... or ?user=alice. (@)restrict grant levels: READ, WRITE, CREATE, UPDATE, DELETE plus custom actions; 'where' supports $user, $now, entity refs. Unknown roles deny by default; requires: 'authenticated-user' is the built-in pseudo role.`
  },
  {
    id: "cap-events",
    corpus: "cap",
    title: "Messaging and events in CAP",
    tags: ["messaging", "event", "emit", "outbox", "enterprise messaging"],
    body: `Define events in CDS: event OrderCreated { book: Books:ID; quantity: Integer } inside a service, or aspect-based with chanel. Emit: const messaging = await cds.connect.to('messaging'); await messaging.emit({ event: 'OrderCreated', data: { book: id, quantity: 3 } });. Receive: messaging.on('OrderCreated', msg => ...). Configure in package.json: "cds": { "requires": { "messaging": { "kind": "enterprise-messaging", "outbox": true } } } — the transactional outbox guarantees emit-after-commit. Local development uses file-based messaging. Events become part of the service model and are exposed in EDMX for Event Mesh bindings.`
  },
  {
    id: "cap-testing",
    corpus: "cap",
    title: "Testing CAP applications",
    tags: ["test", "cds.test", "jest", "integration"],
    body: `Use cds.test() to spin up the full stack in-process: const cds = require('@sap/cds'); const { GET, POST, expect, test } = cds.test(__dirname + '/../'); test('GET books', async () => { const { data } = await GET\`/browse/Books\`; expect(data.value).to.have.length(3); }); await POST\`/browse/submitOrder\` ({ book: 1, quantity: 2 }). Run with jest (test/*.test.js) or mocha. In-memory SQLite starts automatically with your CSV sample data; use cds.test(...).in(folder) for separate data dirs, .with('mock-auth') for users. Best practice: one test suite per service, cover authorization paths with different mocked users, keep tests hermetic (no external services) using connectivity mocks.`
  },
  {
    id: "cap-preview",
    corpus: "cap",
    title: "Previewing CAP services and Fiori apps",
    tags: ["cds watch", "preview", "odata", "catalog"],
    body: `Run cds watch to start the dev server (default port 4004): OData endpoints at /odata/v4/<servicePath>, service documents at /odata/v4/browse/Books/$metadata, Fiori apps served from app/ folder at /<appName>/webapp/index.html (CAP auto-serves the app folder and generates Fiori launchpad sandbox at /$launchpad or via app/@fiori... configuration). cds watch auto-restarts on model changes and re-loads CSV data. With @sap/cds-dbs the default database is SQLite at db.sqlite. The service catalog /odata/v4/catalog?format=json lists all services for Fiori launchpad tiles. Use ?saml2=disabled or mocked users (alice, bob) for auth testing in local preview.`
  }
];
