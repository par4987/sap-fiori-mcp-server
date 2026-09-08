import { fioriDocs } from "./corpus-fiori.js";
import { ui5Docs, capDocs } from "./corpus-ui5-cap.js";
import { btpDocs } from "./corpus-btp.js";
import { searchDocs, type DocEntry, type DocHit } from "../util/search.js";

export const fullCorpus: DocEntry[] = [...fioriDocs, ...ui5Docs, ...capDocs, ...btpDocs];

export type DocScope = "all" | "fiori" | "ui5" | "cap" | "opa5" | "cards" | "typescript" | "btp";

export function searchAllDocs(query: string, limit = 8, scope: DocScope = "all"): DocHit[] {
  const scopes = scope === "all" ? undefined : [scope];
  return searchDocs(fullCorpus, query, limit, scopes);
}

/** Structured guideline documents served by get_guidelines / get_integration_cards_guidelines / get_typescript_conversion_guidelines. */
export const guidelines: Record<string, { title: string; content: string }> = {
  general: {
    title: "UI5 development best practices",
    content: `# UI5 Best Practices

1. **Async everywhere**: always use async XML views (\`async: true\` in rootView), \`Fragment.load()\`, \`Controller.create()\`. Never rely on synchronous XHR or sync views.
2. **AMD modules**: declare dependencies with \`sap.ui.define\` using exact module paths; no globals.
3. **XML views preferred**: they are declarative, preprocessable, and tool-friendly.
4. **Lean controllers**: extract formatters, models and services into dedicated modules (e.g. \`model/formatter.js\`, \`service/ODataService.js\`).
5. **Stable IDs**: prefix ids per control (\`id="saveButton"\`) and access via \`this.byId("saveButton")\`; never navigate the DOM.
6. **i18n**: every user-facing text via the i18n resource model; use placeholders instead of string concatenation.
7. **Binding over code**: prefer data binding and expression bindings over manual \`setValue\` calls; use \`bindElement\`/\`bindList\` with parameters.
8. **Deprecations**: avoid \`jQuery.sap.*\`, \`sap.ui.getCore().byId()\`, \`sap.ui.commons\`, and check release notes; run the linter tool of this server.
9. **Performance**: enable \`growing\` lists for large sets, use list paging (\$top/\$skip), minimize dialogs, avoid deep nesting, enable \`flexEnabled\` only when needed.
10. **Security**: escape user content, avoid \`innerHTML\`, respect CSP, use the UI5 sanitizer for HTML (\`sap/ui/core/util/XMLHelper\` / \`HTML sanitizer\`).
11. **Error handling**: register \`attachValidationError\`/\`attachParseError\` on the router; show MessageBox/sap.m.MessageToast; log with \`Log.error\`.
12. **Testing**: QUnit for unit, OPA5 for integration; keep journeys independent; use mockserver.`
  },
  views: {
    title: "XML views and fragments",
    content: `# XML Views & Fragments

- Root element: \`<mvc:View xmlns:mvc="sap.ui.core.mvc" xmlns="sap.m" controllerName="ns.app.view.Main" displayBlock="true">\`.
- Namespaces: \`xmlns:core="sap.ui/core"\`, \`xmlns:f="sap.f"\`, \`xmlns:layout="sap.ui.layout"\`, \`xmlns:macros="sap.fe.macros"\` for FE building blocks.
- Aggregation binding: \`items="{ path: '/Books', parameters: { expand: 'author' } }"\`.
- Fragments: \`<core:Fragment fragmentName="ns.app.view.Detail" type="XML"/>\` or in controllers \`this.loadFragment({ name: "ns.app.view.Detail" })\` (async, returns Promise).
- \`core:ComponentContainer\` embeds other components; \`core:ExtensionPoint\` marks extension spots for flex changes.
- Always set \`displayBlock="true"\` on views containing an \`sap.m.App\`/\`Shell\`.
- Prefer \`sap.f.FlexibleColumnLayout\` for master-detail-ish desktop UX; \`sap.m.SplitApp\`/\`NavContainer\` for mobile flows.`
  },
  bindings: {
    title: "Data binding patterns",
    content: `# Data Binding

- Property: \`{path}\` or \`{/absolute}\`; composite: \`{ parts: [{path:'price'},{path:'currency'}], formatter: '.fmtPrice' }\` (dot = controller method).
- Expression binding: \`visible="{= \${status} === 'A' }"\` — supported operators: ===, !==, &&, ||, ?:, arithmetic.
- OData V4 model: paths must include keys \`/Books(ID=1)\`; use \`parameters: { expand: 'author' }\` or annotation-driven autoExpandSelect; \`$$updateGroupId\` for batch groups.
- v2: \`useBatch: true\`, defer groups: \`parameters: { groupId: 'changes', deferredGroups: ['changes'] }\` then \ submitChanges()\`.
- Sorters/filters in binding info: \`{ path: '/Books', sorter: [{ path: 'title', descending: false }], filters: [new Filter('stock','GT',0)] }\`.
- Relative contexts: \`this.getView().setBindingContext(ctx)\`, list item \`getBindingContext()\` → \ getPath()\`.
- Two-way is default for JSONModel; OData V4 two-way requires server PATCH support.`
  },
  routing: {
    title: "Routing configuration",
    content: `# Routing

Manifest \ sap.ui5/routing\`:
- \`config\`: routerClass (\`sap.m.routing.Router\` or \`sap.f.routing.Router\` for FCL), viewType XML, async true, viewPath, controlId + controlAggregation (e.g. \`app\` + \`pages\`, or FCL \`beginColumnPages\`/\`midColumnPages\`/\`endColumnPages\`).
- \`routes\`: ordered array; pattern with parameters \ detail/{ID}\`, optional suffix \ :?query:\` for URL params; \`empty\` pattern \ ""\` for home.
- \`targets\`: viewName + viewId (+ \`controlAggregation\` overrides); type \`Component\` for Fiori elements targets.
- Navigation: \`this.getRouter().navTo("detail", { ID: "1" })\`; back: \ getRouter().getHashChanger().historyBack()\` or \`oHistory\`.
- Deep linking: \`attachRoutePatternMatched\`/\`attachBypassed\`; restore app state from \ ?query\` params.
- Guard routes with \`this.oOwnerComponent.getRouter().attachBeforeRouteMatched\` when authorization checks are needed.`
  },
  i18n: {
    title: "Internationalization",
    content: `# i18n

- manifest model: \`"i18n": { "type": "sap.ui.model.resource.ResourceModel", "settings": { "bundleName": "ns.app.i18n.i18n" } }\`.
- View usage: \`{i18n>key}\`; controller: \ getResourceBundle().getText("key", [args])\`.
- Texts: \`key=Hello {0}\`; plural forms via \ key_plural=...\` and \ getText\` with count; keep keys stable.
- Locale files: i18n.properties (default/en), i18n_de.properties, i18n_es.properties...; supportedLocales/fallbackLocale in settings.
- Formatting: UI5 formats dates/numbers per user locale automatically; force with \ core:formatConfiguration\` or model settings.
- Never concatenate translated fragments; always whole sentences with placeholders.`
  },
  performance: {
    title: "Performance checklist",
    content: `# Performance

- Keep the bootstrap minimal and preload only needed libs (\ sap.ui5/dependencies/libs\`).
- Enable \`growing\`/\`threshold\` on large lists; server-side paging with $top/$skip.
- Use \`preload: true\` for the main OData model; batch requests; avoid N+1 expands (check network).
- Defer heavy views: \`sap.ui.core.mvc.View.load()\` on demand for rarely used screens.
- Compress and cache static resources (ui5 build with minification); enable \`sap-ui-xx-viewCache\` off only in dev.
- Avoid unnecessary rerendering: change models in bulk, use \ invalidate()\` sparingly.
- Measure with UI5 support tools (\ sap-ui-support=true\`) and Chrome performance panel.`
  },
  security: {
    title: "Security guidelines",
    content: `# Security

- Never trust client input; validate server-side (CAP handlers, OData validation).
- Escape dynamic HTML: use \`sap.m.Text\` (auto-escapes) instead of \`FormattedText\` unless sanitized.
- CORS: use server-side proxies (CAP middlewares, ui5-middleware-simpleproxy) in dev; never disable browser security.
- Auth: store credentials server-side; MCP SAP connections use environment variables — never commit passwords.
- Keep UI5 updated; subscribe to security advisories (CVE patch day) and pin \ minUI5Version\` to a maintained release.
- CSP: start with frame-ancestors 'self'; UI5 supports CSP via meta tag or server headers.`
  },
  testing: {
    title: "Testing with QUnit and OPA5",
    content: `# Testing

- QUnit: unit test formatters, models, controllers in isolation (webapp/test/unit).
- OPA5: integration journeys (webapp/test/integration) with Given/When/Then; start app with \ iStartMyUIComponent\` or FLP embedding.
- Fiori elements: reuse \ sap/fe/test\` ListReport/ObjectPage page objects; test filters, navigation, custom actions.
- Mockserver: \ sap/ui/core/util/MockServer\` with metadata.xml + mockdata for hermetic tests.
- Run: \`npm test\` (karma-ui5 or @ui5/tooling); CI: headless Chrome, coverage via nyc/istanbul.`
  },
  cards: {
    title: "UI Integration Cards best practices",
    content: `# Integration Cards Guidelines

1. Keep manifests small: only the properties you render; fetch data with a single request (\ sap.card/content/data/request\`).
2. Choose the right type: List for items, Object for a single entity, Table for tabular data, Analytical for charts, Timeline for feeds, Component for custom UI5 UI, Adaptive for MS Teams schema.
3. Header: use \ type: "Numeric"\` with \ details\` for KPI cards; provide \ actions\` (Navigation) so cards link to the app.
4. Binding: \${/\` placeholders map response fields: \ "{title}"\`; use \ $parameters\`/\`filters\` for OData queries and refresh with \ refresh\` interval.
5. i18n: card manifests support \ sap.app/i18n\` bundle and \ @{i18n>key}\` binding syntax.
6. Use \ sap.card/configuration/parameters\` to make cards configurable in Work Zone destinations.
7. Preview locally with the Card Explorer; validate with the \ run_manifest_validation\` tool (type: card) and test data sources with \ download_odata_service_metadata\`.
8. Keep item templates flat — complex nesting breaks in destination environments; max 5-7 visible items.`
  },
  typescript: {
    title: "JavaScript → TypeScript conversion guide",
    content: `# UI5 TypeScript Conversion

## 1. Dependencies
\`\`\`json
"devDependencies": {
  "typescript": "^5",
  "@types/openui5": "1.x",        // or @sapui5/ts-types-esm
  "ui5-tooling-transpile": "^3",
  "@ui5/ts-interface-generator": "^2"
}
\`\`\`

## 2. tsconfig.json
\`\`\`json
{ "compilerOptions": { "target": "ES2022", "module": "ES2022", "moduleResolution": "bundler", "strict": true, "experimentalDecorators": false, "skipLibCheck": true } }
\`\`\`

## 3. Convert controllers
\`\`\`ts
import Controller from "sap/ui/core/mvc/Controller";
import JSONModel from "sap/ui/model/json/JSONModel";
export default class Main extends Controller {
  onInit(): void {
    this.getView()!.setModel(new JSONModel({ items: [] }));
  }
  onPress(oEvent: import("sap/m/Button").$ButtonPressEvent): void {
    const id = (oEvent.getSource() as import("sap/m/Button").default).getId();
  }
}
\`\`\`

## 4. Build
Add ui5-tooling-transpile custom task + middleware to ui5.yaml; keep XML views unchanged; manifest component path stays \ "*.Component"\`.

## 5. Types
- Models: cast \ this.getModel() as sap/ui/model/odata/v4/ODataModel\`.
- Events: use typed \ $...Event\` interfaces from the d.ts.
- ControllerExtension (Fiori elements): \`\`\`ts
import ControllerExtension from "sap/fe/core/ControllerExtension";
class MyExt extends ControllerExtension { static overrides = { ... } }
\`\`\`

## 6. Verify
Run \`npx tsc --noEmit\`, then the app; UI5 runtime still consumes plain AMD — the transpile task handles exports.`
  }
};
