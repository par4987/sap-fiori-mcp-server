# @pired/sap-fiori-mcp-server

[![CI](https://github.com/par4987/sap-fiori-mcp-server/actions/workflows/ci.yml/badge.svg)](https://github.com/par4987/sap-fiori-mcp-server/actions/workflows/ci.yml)

**Servidor MCP (Model Context Protocol) unificado para desarrollo SAP Fiori — creado desde cero, en TypeScript, sin dependencias de SAP.**

Un único binario que combina las capacidades de los tres servidores MCP de referencia del ecosistema SAP, **más conectividad a SAP BTP**:

| Inspiración | Capacidades replicadas |
|---|---|
| [`@sap-ux/fiori-mcp-server`](https://github.com/SAP/open-ux-tools/tree/main/packages/fiori-mcp-server) | Generación y modificación de apps Fiori elements, búsqueda documental, descarga de metadata OData |
| [`@ui5/mcp-server`](https://github.com/UI5/mcp-server) | Scaffolding UI5, integration cards, API reference, guidelines, validación de manifest, linter |
| [`@cap-js/mcp-server`](https://github.com/cap-js/mcp-server) | Búsqueda fuzzy sobre el modelo CDS, detalles de definiciones, queries sobre datos de ejemplo |
| ➕ **SAP BTP** | Destinations locales y del **BTP Destination Service**, queries OData V2/V4 remotas (`query_odata_data`) |

> 📖 English documentation: [README.en.md](./README.en.md)

---

## ✨ Características

- **28 tools MCP** listas para usar con Claude Desktop, Claude Code, Cursor, VS Code (Copilot), Cline, Windsurf o cualquier cliente MCP.
- **Publica la app que genera**: `deploy_fiori_app` valida, compila (`ui5 build`, o `webapp/` cuando no está el tooling), archiva y sube la app al sistema ABAP que le corresponde —on-premise o ABAP Environment en BTP— y termina abriendo la URL pública para comprobar que responde. Un solo paso, sin confirmación: la app solo está hecha cuando contesta.
- **Soporte SAP BTP**: destinations desde variables de entorno, archivos o del **Destination Service** en la nube (OAuth2 automático, secretos siempre redactados).
- **5 floorplans Fiori elements**: `list-report`, `object-page` (form entry), `worklist`, `analytical-list-page` (V2) y `overview-page` (V2).
- **Apps que arrancan, no solo que validan**: cada variante (V4, V4 con parámetros, worklist, V2 y CAP) se ha abierto en un navegador contra un servicio real. Ver [Qué sale al generar una app](#-qué-sale-al-generar-una-app-y-qué-se-ha-comprobado).
- **Anotaciones y entidad elegidas del propio servicio**: el documento de anotaciones de un servicio V2 se busca en el catálogo y se declara solo; la entidad principal sale de `UI.LineItem`/`HeaderInfo`/`DraftRoot`, no del orden del documento.
- **Doble transporte**: `stdio` (por defecto) y **HTTP Streamable** (`--http --port 3001`) con API key opcional.
- **Sin dependencias de SAP**: parser CDS, parser EDMX, cliente OData V2/V4 y motor de queries CSV implementados desde cero en TypeScript (~0 dependencias de runtime: solo el SDK oficial de MCP y zod).
- **Documentación integrada**: corpus local de Fiori Elements, UI5, CAP, OPA5 y BTP con búsqueda TF-IDF — funciona sin conexión.
- **Salida estructurada**: todas las tools declaran `outputSchema` y devuelven `structuredContent`, además del JSON en texto, y anotaciones de comportamiento (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`).
- **Paginación explícita** en las tools de búsqueda y consulta: `count`, `total`, `hasMore` y `nextOffset`/`nextSkip`.
- **Seguridad por diseño**: credenciales solo por variables de entorno, secretos redactados en las respuestas, API key y validación de `Origin` (anti DNS-rebinding) en modo HTTP, allowlist opcional de hosts salientes, regla de no-registro en stdout.

## 📦 Instalación

```bash
# Uso directo con npx (una vez publicada la versión en npm):
npx @pired/sap-fiori-mcp-server

# Instalación global:
npm install -g @pired/sap-fiori-mcp-server
sap-fiori-mcp --http --port 3001

# Desde el tarball sin publicar:
npm install -g pired-sap-fiori-mcp-server-1.1.0.tgz

# Desde el código:
npm install && npm run build
```

> Guía de publicación en NPM: [`docs/NPM-PUBLISH.md`](./docs/NPM-PUBLISH.md).

### Probar con el proyecto de ejemplo

```bash
# el repo incluye examples/bookshop (CAP) con modelo CDS y datos CSV
# desde otra terminal, con el servidor en modo HTTP:
curl -X POST http://localhost:3001/mcp \
  -H "content-type: application/json" \
  -H "accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search_model","arguments":{"projectPath":"./examples/bookshop","query":"Books","kind":"entity"}}}'
```

## ⚙️ Configuración por cliente MCP

### Claude Code

```bash
# Una vez publicado en npm, la forma más simple:
claude mcp add sap-fiori-mcp -- npx -y @pired/sap-fiori-mcp-server

# O apuntando a una copia local del código:
claude mcp add sap-fiori-mcp -- node /ruta/absoluta/sap-fiori-mcp-server/dist/index.js
```

O crea un `.mcp.json` en la raíz del proyecto:

```json
{
  "mcpServers": {
    "sap-fiori-mcp": {
      "type": "stdio",
      "timeout": 600,
      "command": "node",
      "args": ["/ruta/absoluta/sap-fiori-mcp-server/dist/index.js"],
      "env": { "LOG_LEVEL": "info" }
    }
  }
}
```

### Claude Desktop

Edita `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`, Windows: `%APPDATA%\Claude\`):

```json
{
  "mcpServers": {
    "sap-fiori-mcp": {
      "command": "node",
      "args": ["/ruta/absoluta/sap-fiori-mcp-server/dist/index.js"],
      "env": {
        "SAP_BASE_URL": "https://tu-sistema:44300",
        "SAP_CLIENT": "100",
        "SAP_USER": "DEVELOPER",
        "SAP_PASSWORD": "tu-password"
      }
    }
  }
}
```

### Cursor

Edita `.cursor/mcp.json` (proyecto) o `~/.cursor/mcp.json` (global):

```json
{
  "mcpServers": {
    "sap-fiori-mcp": {
      "type": "stdio",
      "command": "node",
      "args": ["/ruta/absoluta/sap-fiori-mcp-server/dist/index.js"]
    }
  }
}
```

### VS Code (Copilot / Cline)

`.vscode/mcp.json`:

```json
{
  "servers": {
    "sap-fiori-mcp": {
      "type": "stdio",
      "command": "node",
      "args": ["/ruta/absoluta/sap-fiori-mcp-server/dist/index.js"]
    }
  },
  "inputs": []
}
```

> En Windows nativo (no WSL) usa `"command": "cmd"` y `"args": ["/c", "node", "...\\dist\\index.js"]`.

### Modo HTTP (equipo / remoto)

```bash
SAP_FIORI_MCP_API_KEY=mi-secreto node dist/index.js --http --port 3001 --host 0.0.0.0
```

Endpoints: `POST /mcp` (MCP Streamable HTTP) y `GET /health` (estado del servidor).

> 🔒 **Protección DNS-rebinding**: el servidor valida la cabecera `Origin`. Las peticiones sin `Origin`
> (clientes MCP, curl, extensiones de IDE) y las de `localhost`/`127.0.0.1` se aceptan; cualquier otro
> origen de navegador se rechaza con 403 salvo que lo declares en `SAP_FIORI_MCP_ALLOWED_ORIGINS`.
> Si expones el servidor con `--host 0.0.0.0`, usa siempre `SAP_FIORI_MCP_API_KEY`.

```json
{
  "mcpServers": {
    "sap-fiori-mcp": {
      "type": "streamableHttp",
      "url": "http://tu-servidor:3001/mcp",
      "headers": { "x-api-key": "mi-secreto" }
    }
  }
}
```

### Docker

```bash
docker build -t sap-fiori-mcp-server .
# HTTP:
docker run -p 3001:3001 -e SAP_FIORI_MCP_API_KEY=secreto sap-fiori-mcp-server --http --port 3001 --host 0.0.0.0
# stdio (cliente dockerizado):
docker run -i --rm sap-fiori-mcp-server
```

## 🧰 Tools disponibles (28)

### Documentación y guías

| Tool | Descripción |
|---|---|
| `search_docs` | Búsqueda semántica (TF-IDF) sobre el corpus local de Fiori Elements, anotaciones, UI5, OPA5, cards, TypeScript, CAP y BTP destinations. Parámetros: `query`, `scope` (all/fiori/ui5/cap/opa5/cards/typescript/btp), `limit`. |
| `get_guidelines` | Mejores prácticas UI5 por tema: `general`, `views`, `bindings`, `routing`, `i18n`, `performance`, `security`, `testing`. |
| `get_integration_cards_guidelines` | Guía de desarrollo de UI Integration Cards. |
| `get_typescript_conversion_guidelines` | Guía paso a paso para convertir apps UI5 de JavaScript a TypeScript. |

### Fiori (generación y modificación)

| Tool | Descripción |
|---|---|
| `list_fiori_apps` | Escanea un workspace y lista las apps Fiori existentes (FE V4/V2, freestyle, cards, adaptación) con su entitySet, versión OData y vistas. |
| `list_sap_systems` | Lista los sistemas SAP configurados (env vars o `~/.sap-fiori-mcp/systems.json`). |
| `download_odata_service_metadata` | Descarga el `$metadata` EDMX de un servicio OData V2/V4 y lo guarda como `metadata.xml`; devuelve resumen de entity sets y tipos. Acepta `serviceUrl`, `systemName (+servicePath)` o `destination (+servicePath)` BTP. |
| `get_metadata_summary` | Resume un `metadata.xml` local (entidades, claves, asociaciones, anotaciones). |
| `generate_fiori_app_odata` | Genera una app Fiori elements para servicios OData no-CAP (p.ej. RAP). Acepta `destination`/`systemName` + `servicePath` —los mismos argumentos que descargaron la metadata— y escribe la URL real del servicio en el manifest. En V2 busca el documento de anotaciones del servicio en el catálogo y lo declara. Sin `entitySet` elige la entidad por sus anotaciones, no por el orden del documento. **Floorplans**: `list-report` (LR+ObjectPage, V4+V2), `object-page` (form entry, V4), `worklist` (V4+V2), `analytical-list-page` (V2), `overview-page` (V2). Opcional: FCL, initial load. Los combos no soportados se ajustan con warning, y avisa cuando al servicio le faltan las anotaciones que el floorplan necesita. |
| `generate_fiori_app_cap` | Genera una app Fiori elements dentro de un proyecto CAP existente, resolviendo servicio y entidad del modelo CDS automáticamente. La URL del servicio sigue a la versión de `@sap/cds` del proyecto (cds 10 monta un `@path` absoluto tal cual; antes llevaba `/odata/v4` delante), la app arranca UI5 desde el CDN porque `cds` sirve la carpeta de la app y nada más, y avisa si la entidad no tiene `UI.LineItem` —sin ella la tabla sale sin columnas—. Floorplans: `list-report`, `object-page`, `worklist`. |
| `list_functionality` | **Paso 1/3** — Lista las modificaciones soportadas para una app existente. |
| `get_functionality_details` | **Paso 2/3** — Parámetros requeridos por una funcionalidad. |
| `execute_functionality` | **Paso 3/3** — Ejecuta: `add_page`, `delete_page`, `add_controller_extension`, `enable_fcl`, `enable_initial_load`, `update_manifest`. |

### UI5

| Tool | Descripción |
|---|---|
| `create_ui5_app` | Scaffolding freestyle: `basic`, `worklist` (tabla + object page), `master-detail` (FCL), `fcl` (Flexible Column Layout con routing por columnas) o `tabs` (IconTabBar). |
| `create_integration_card` | Crea una UI Integration Card (List, Object, Table, Timeline, Analytical, Adaptive, Component, Calendar) con preview. |
| `get_api_reference` | API reference de un control (p.ej. `sap.m.Table`) con JSDoc, desde los type definitions oficiales (`@openui5/ts-types-esm` vía CDN, con caché local). |
| `get_project_info` | Extrae metadata y configuración de un proyecto UI5/CAP (framework, libs, vistas, modelos, routing). |
| `get_version_info` | Versiones del framework UI5 (CDN `sap-ui-version.json` + versión local del proyecto). |
| `run_manifest_validation` | Valida `manifest.json`: patrón del id, dataSources, modelos, routing/targets, existencia de vistas e i18n, estructura de cards. |
| `run_ui5_linter` | Linter UI5: APIs deprecadas (`jQuery.sap.*`, `sap.ui.getCore().byId`), librerías eliminadas, controles deprecados, controladores e i18n faltantes. |

### CAP / CDS

| Tool | Descripción |
|---|---|
| `search_model` | Búsqueda fuzzy sobre las definiciones del modelo CDS compilado (entidades, vistas, servicios, types, aspects, events, actions). |
| `get_cap_details` | Detalles completos de una definición: elementos, claves, asociaciones (target, cardinalidad, on-condition), actions y functions **con sus parámetros** (nombre, tipo, `default`, colecciones), anotaciones y exposición por servicio. |
| `query_cap_data` | Ejecuta queries tipo CQN sobre los datos de ejemplo CSV de CAP (`db/data/<namespace>-<Entity>.csv`): columnas, filtro WHERE-like (`and`/`or`, `eq/ne/gt/ge/lt/le`, `contains`), orden, skip/limit. |

### SAP BTP (destinations y OData remoto)

| Tool | Descripción |
|---|---|
| `list_btp_destinations` | Lista los destinations disponibles: locales (env/JSON/archivo/carpeta) y del **BTP Destination Service** en la nube. Secretos redactados. |
| `get_btp_destination` | Detalles de un destination (URL, auth, sap-client, headers) con secretos redactados y preview de la autenticación resuelta. |
| `btp_login` | Abre el navegador para el login único de BTP de un `destination` y guarda el refresh token, de modo que las llamadas posteriores se renuevan solas. Es el único paso que no puede resolverse desde un resultado de tool: BTP delega en un proveedor de identidad con SSO y segundo factor, así que hace falta un navegador de verdad. Antes solo existía en el panel y en `--btp-login`, y una tool que fallaba por token caducado solo sabía mandarte a un terminal. Un cliente MCP abandona una tool call a los 60 s y un login con SSO y segundo factor no cabe ahí, así que la llamada devuelve `pending: true` con la URL en cuanto el navegador está abierto: terminás el login y **volvés a llamarla** para recoger el resultado. `noBrowser` devuelve la URL en vez de abrirla. |
| `query_odata_data` | Ejecuta una query OData V2/V4 contra un entity set vía `destination` BTP, `systemName` de `list_sap_systems` o `serviceUrl` directa. Soporta `$filter`, `$top`, `$skip`, `$select`, `$orderby`, `$expand` y el total de filas (`$count` en V4, `$inlinecount` en V2). La versión se detecta sola: un servicio V2 rechaza `$count` sin nombrarlo —Gateway responde «Invalid system query option specified»— así que el reintento se decide por el código de estado, no por el texto. Es la contraparte remota de `query_cap_data`. |

### Despliegue (publicación en el sistema ABAP)

| Tool | Descripción |
|---|---|
| `deploy_fiori_app` | **Valida → compila → sube → verifica**, sin paso intermedio de confirmación. Toma `appPath` (la carpeta generada) y sube el zip al servicio `UI5/ABAP_REPOSITORY_SRV` (`POST /Repositories` para crear, `PUT /Repositories('<BSP>')` para actualizar), que es el mismo protocolo en S/4 on-premise y en ABAP Environment de BTP. El destino se deduce de la URL del servicio que ya está escrita en el manifest; `systemName` o `destination` lo imponen. El nombre del BSP se sanea solo (≤15 caracteres, guiones → `_`), la app va al paquete `$TMP` salvo que `package` diga lo contrario (entonces hace falta `transport`), y si el sistema **rechaza** `$TMP` —como hace ABAP Environment, con `/UI5/UI5_REP_LOAD/003`— el servidor busca o **crea solo** el paquete que sí acepta (colgando del componente de software del cliente, vía ADT `/sap/bc/adt/packages`) y vuelve a subir sin preguntar; una app ya publicada reutiliza el paquete en el que se creó. `index.html` reescribe el bootstrap a `ui5.sap.com` —o a los recursos del propio sistema con `bootstrap: "local"`— porque `resources/sap-ui-core.js` tal cual queda en 404 detrás de `/sap/bc/ui5_ui5/sap/<bsp>/`. Compila con `ui5 build` si el proyecto tiene `@ui5/cli` —instalándolo si falta `node_modules`— y si algo falla sube `webapp/` en vez de cortar, con el motivo en `warnings`. Termina con `GET` de la URL pública (`/sap/bc/ui5_ui5/sap/<bsp>`): `ok: true` solo si la app contesta 200. El mensaje del sistema (`sap-message`) viaja en la respuesta y los errores de autorización se reportan como tales, no como éxito. |

## 🧭 Qué sale al generar una app (y qué se ha comprobado)

Las apps generadas se han **ejecutado en un navegador** contra servicios reales, no solo validado.
Cada variante de esta tabla se abrió, cargó datos y se navegó:

| Variante | Servicio de prueba | Resultado |
|---|---|---|
| OData V4, list report + object page | `/DMO/UI_TRAVEL_D_D` (BTP) | 4.136 viajes; detalle con su faceta de reservas |
| OData V4, worklist | `/DMO/UI_TRAVEL_D_D` | carga sola, sin pulsar *Ir* |
| OData V4, CDS con parámetros | binding propio sobre `/DMO/I_Travel_U` | sap.fe pide los parámetros y lista 2.017 filas |
| OData V2, list report + object page | `ZUI_TRAVEL_APP` | 40 viajes con columnas, filtros y acciones; detalle con 4 reservas |
| CAP (cds 10) | `examples/bookshop` | 6 libros con las columnas que describen las anotaciones |

**Cómo se elige la entidad** cuando no se pasa `entitySet`: se toman los entity sets con
`UI.LineItem`; de esos, los que además tienen `UI.HeaderInfo` o `UI.Facets` —un value help lleva
`LineItem` para su popup, pero nadie le escribe un object page—; y entre los que quedan manda el
`Common.DraftRoot` que declare el servicio, luego la raíz de la composición y luego
`UI.SelectionFields`, que es la barra de filtros de la página sobre la que abre la app. Sin
anotaciones se usa el primer entity set, como antes.

**Anotaciones de un servicio V2**: un servicio Gateway guarda las anotaciones UI fuera de su
`$metadata`. El generador pregunta al catálogo por el documento del servicio, lo declara como
`ODataAnnotation`, guarda una copia en `localService/` y lo usa también para elegir la entidad.
Sin catálogo, sin autorización o con el modelo vacío, la generación sigue igual que antes.

**CDS con parámetros**: las páginas se direccionan por `contextPath` (`/Entidad/Set`), que es lo que
hace que sap.fe pida los parámetros antes de cargar nada.

### Limitaciones conocidas

- **Sin object page para una entidad paramétrica.** sap.fe no lo contempla: resuelve la página contra
  la entidad de parámetros y pide rutas que no existen (`…/Set('1')/p_from`), así que el detalle solo
  podría abrir vacío. Se genera el list report y se avisa; expón la entidad resultado sin parámetros
  si necesitas detalle.
- **`analytical-list-page` necesita anotaciones analíticas** (`UI.Chart`, `UI.PresentationVariant`).
  Si el servicio no las trae, se genera igual pero se avisa: la página abriría con un error.
- **`overview-page` es un andamio**: arranca y pinta los marcos de las tarjetas, pero las tarjetas no
  enlazan a datos. Descríbelas en `sap.ovp/cards` con su `annotationPath` antes de usarla. El aviso
  lo dice al generar.
- **Despliegue sujeto a autorización del sistema**: `deploy_fiori_app` necesita permiso de escritura en
  `UI5/ABAP_REPOSITORY_SRV`. Sin él el sistema responde 403
  (`/IWFND/CM_CONSUMER/101 No authorization to access Service`) y la tool lo devuelve como error con esa
  misma frase, nunca como éxito. Pídeselo al administrador (SU53 deja el motivo del último intento).

## 🖥️ Panel de conexiones

```bash
npx @pired/sap-fiori-mcp-server --admin
```

Abre un panel local para dar de alta, editar, renombrar y borrar sistemas SAP y destinations BTP,
y **probar cada conexión** —sistema o destination— antes de usarla: alcance del host, aceptación de credenciales y lectura
de `$metadata`, mostrando el código HTTP, el sistema que responde (`sap-system`), el realm y el
mensaje real de SAP. También informa de si el certificado TLS es de confianza y de qué variables
`${env:...}` no están definidas.

Los destinations con service key traen además un botón **Token BTP**: dice si hay token guardado y
cómo está sellado, lo **valida contra el tenant** (gastándolo en un access token, que es la única
autoridad sobre si sigue vivo), permite iniciar sesión desde ahí mismo y olvidarlo. Un token
guardado es invisible hasta que falla: se ve igual funcionando que caducado.

Cuatro cosas lo mantienen a raya:

- Escucha **solo en `127.0.0.1`**; no existe opción para cambiarlo.
- Exige un **token generado en cada arranque**, impreso una vez en consola y enviado en cabecera.
- **No usa cookies**, así que otra pestaña no puede lograr que el navegador se autentique sola.
- Rechaza cualquier petición cuyo `Host` no nombre al loopback, que es lo que cierra el
  DNS-rebinding desde el propio navegador del operador.

Y la regla que lo sostiene: **ningún secreto entra ni sale**. La contraseña solo se acepta como
`${env:NOMBRE}`; los secretos que ya estuvieran literales en un fichero de destination se
conservan intactos al editar, pero nunca se devuelven.

| Variable | Por defecto | Descripción |
|---|---|---|
| `SAP_FIORI_MCP_ADMIN_PORT` | `7392` | Puerto del panel (también con `--port`). |

## 🔧 Variables de entorno

| Variable | Default | Descripción |
|---|---|---|
| `LOG_LEVEL` | `error` | `off`, `error`, `warn`, `info`, `debug` (log a archivo, nunca a stdout). |
| `SAP_FIORI_MCP_LOG_FILE` | `~/.sap-fiori-mcp/server.log` | Ruta del log. |
| `SAP_FIORI_MCP_WORKSPACE_ROOT` | cwd | Raíz por defecto para rutas relativas. |
| `SAP_BASE_URL` / `SAP_USER` / `SAP_PASSWORD` / `SAP_CLIENT` / `SAP_SYSTEM_NAME` | — | Sistema SAP "default" con Basic Auth. |
| `SAP_SYSTEMS_JSON` o `SAP_SYSTEMS_FILE` | `~/.sap-fiori-mcp/systems.json` | Varios sistemas: `[{ "name", "url", "client", "user", "password" }]`. UTF-8, con o sin BOM. Admite `${env:NOMBRE}` en cualquier campo para no guardar contraseñas en el fichero. Si algo no se puede leer o falta una variable, `list_sap_systems` lo dice en `warnings` en vez de reportar cero sistemas. |
| `SAP_DESTINATIONS_JSON` | — | Destinations BTP inline: `[{ "Name", "URL", "Authentication", ... }]` (también acepta el env `destinations` del Cloud SDK). |
| `SAP_DESTINATIONS_FILE` / `SAP_DESTINATIONS_DIR` | dir: `~/.sap-fiori-mcp/destinations` | Un JSON por destination (`<nombre>.json`, formato cockpit export o camelCase). |
| `BTP_CLIENT_ID` / `BTP_CLIENT_SECRET` / `BTP_TOKEN_URL` / `BTP_DESTINATION_API_URL` | — | Conexión al **BTP Destination Service** (o detección automática vía `VCAP_SERVICES`). |
| `BTP_USER_TOKEN` | — | Token de usuario para destinations `OAuth2UserTokenExchange` / `OAuth2JWTBearer`. |
| `UI5_DISTRIBUTION` | `openui5` | `openui5` (sdk.openui5.org) o `sapui5` (ui5.sap.com). |
| `UI5_CDN_URL` | según distribución | CDN alternativo para versiones de UI5. |
| `UI5_TYPES_CDN_URL` | jsDelivr `@openui5/ts-types-esm` | Fuente de los type definitions para `get_api_reference`. |
| `SAP_FIORI_MCP_API_KEY` | — | API key requerida en modo HTTP (`x-api-key` o `Authorization: Bearer`). |
| `SAP_FIORI_MCP_ALLOWED_DOMAINS` | *(vacío = sin restricción)* | Allowlist de hosts salientes. Limita las URLs pasadas como argumento (`serviceUrl`); los hosts de tus sistemas, destinations y CDNs configurados siempre se permiten. Admite `*.dominio.com`. |
| `SAP_FIORI_MCP_ALLOWED_ORIGINS` | *(solo loopback)* | Modo HTTP: orígenes de navegador aceptados. `*` desactiva la comprobación. |
| `SAP_FIORI_MCP_TOOL_PREFIX` | — | Prefija todos los nombres de tools (p. ej. `sapfiori_search_docs`) para evitar colisiones con otros servidores MCP. |
| `SAP_FIORI_MCP_TIMEOUT_MS` | `30000` | Timeout de requests OData/CDN. |
| `SAP_FIORI_MCP_RESPONSE_NO_RESOURCES` | — | Desactiva los recursos MCP (clientes sin soporte). |

Ejemplo de archivo de sistemas (`~/.sap-fiori-mcp/systems.json`):

```json
[
  { "name": "S4H-DEV", "url": "https://s4dev:44300", "client": "100", "user": "DEV", "password": "secret" },
  { "name": "BTP-ABAP", "url": "https://xxx.abap-web.eu10.hana.ondemand.com", "user": "mail@corp.com", "password": "secret" }
]
```

## ☁️ Conectividad SAP BTP

### 1. Destinations locales (sin nube)

Un JSON por destination en `~/.sap-fiori-mcp/destinations/` (o `SAP_DESTINATIONS_JSON` inline). Formato cockpit export o camelCase:

```json
{
  "Name": "S4H",
  "URL": "https://s4.example.com:44300",
  "Authentication": "BasicAuthentication",
  "User": "dev",
  "Password": "secret",
  "sap-client": "100"
}
```

Para OAuth2: `{ "name": "SFSF", "authType": "OAuth2ClientCredentials", "clientId": "...", "clientSecret": "...", "tokenServiceUrl": "https://...authentication.eu10.hana.ondemand.com" }` — el token se intercambia automáticamente en cada request.

### 2. BTP Destination Service (nube)

Lo más simple es apuntar al fichero de **service key** tal como se descarga del cockpit, sin repartir sus campos:

```bash
export BTP_SERVICE_KEY_FILE=/ruta/a/destination-key.json
```

Se leen de él `clientid`, `clientsecret`, la URL de UAA (`url`) y la API de destinations (`uri`). El fichero se queda
donde está: el secreto no se copia a ninguna otra parte. Si prefieres las variables sueltas, siguen funcionando:

```bash
export BTP_CLIENT_ID="sb-..."
export BTP_CLIENT_SECRET="..."
export BTP_TOKEN_URL="https://subaccount.authentication.eu10.hana.ondemand.com"
export BTP_DESTINATION_API_URL="https://destination-configuration.cfapps.eu10.hana.ondemand.com"
# Alternativa: detección automática desde VCAP_SERVICES (deploy en CF/Kyma)
```

Un **destination OAuth** también puede apuntar a su service key en lugar de deletrear las credenciales:

```json
{ "Name": "TRL", "Authentication": "OAuth2ClientCredentials",
  "serviceKeyPath": "/ruta/a/abap-key.json" }
```

> **Cuidado con el host `-web`.** Un ABAP Environment tiene dos: el que nombra la service key sirve
> las APIs (ADT y OData), y su gemelo `-web` sirve el launchpad. Llamar al `-web` desde código
> devuelve **200 con una página de login**, que despista más que un error. Los servicios se consumen
> en el host de la key, y exigen token de usuario nombrado también para OData.

> **Por qué `OAuth2ClientCredentials` falla contra un ABAP Environment.** El token se emite sin
> problema, pero llega con un único scope, `uaa.resource`, que no autoriza nada en el ABAP: el
> sistema responde 401 con `sap-authenticated: false`, idéntico a unas credenciales incorrectas.
> El panel muestra ahora los scopes del token junto al paso de autenticación, que es lo que
> distingue "credencial mala" de "este cliente no tiene permiso aquí".

Para un **ABAP Environment (Steampunk)** no sirve `OAuth2ClientCredentials`: ese token pertenece al
cliente OAuth y a ninguna persona, y el ABAP responde 401 porque no tiene usuario con el que ejecutar.
Hace falta un usuario nombrado, y en un subaccount con proveedor de identidad (trial, o corporativo con
SSO) eso no es una contraseña sino un **refresh token** de un login por navegador hecho una vez:

```bash
npx @pired/sap-fiori-mcp-server --btp-login --destination BTP
```

Abre el navegador, haces login como siempre (SSO y segundo factor incluidos) y **guarda el refresh
token él mismo**, en `~/.sap-fiori-mcp/tokens/<destination>.json`. En Windows va sellado con DPAPI:
solo ese usuario de Windows y en esa máquina puede abrirlo. Después basta con poner el destination
en `OAuth2RefreshToken`; no hay que copiar nada:

```json
{ "Name": "BTP", "Authentication": "OAuth2RefreshToken",
  "serviceKeyPath": "/ruta/a/btp-key.json" }
```

Si prefieres gestionarlo tú, un `refreshToken` explícito como `${env:NOMBRE}` tiene prioridad sobre
el almacén. Es el único secreto que este servidor guarda en un fichero propio, y lo hace porque lo
genera él: pedirte que lo copies a mano sería un paso manual para un valor que nadie eligió.

El flujo es *authorization code* con PKCE y redirect a loopback, el mismo que usa Eclipse ADT.
`OAuth2Password` sigue disponible para subaccounts cuyos usuarios viven en la propia UAA.

Se entienden las tres formas que emite BTP: la del Destination service (`uri` + `url`), la de ABAP Environment
(credenciales bajo `uaa`, y de la que se toma también la URL del sistema) y la de XSUAA.

Si el Destination Service devuelve tokens pre-intercambiados (`authTokens`), se usan tal cual — así destinations OAuth2 o On-Premise funcionan sin exponer secretos.

### 3. Flujo típico con el modelo de IA

```
list_btp_destinations → get_btp_destination (verificar auth) → query_odata_data (validar datos)
→ download_odata_service_metadata (destination + servicePath) → generate_fiori_app_odata
→ deploy_fiori_app
```

Los secretos (password, clientSecret, tokens) **nunca** aparecen en las respuestas de las tools.

## 🔒 Certificados SSL autofirmados

Si tu sistema SAP usa un certificado autofirmado (`unable to get local issuer certificate`):

**Opción recomendada** — CA personalizada:
```json
"env": { "NODE_EXTRA_CA_CERTS": "/ruta/a/ca.crt" }
```

**Opción no recomendada (solo dev)** — desactivar validación TLS:
```json
"env": { "NODE_TLS_REJECT_UNAUTHORIZED": "0" }
```

## 🤖 Reglas para el modelo de IA

Copia las reglas de [`docs/AGENTS-rules.md`](./docs/AGENTS-rules.md) en tu `AGENTS.md`/`CLAUDE.md`/`.cursorrules` para que el asistente use el servidor correctamente (igual que hacen los servidores de SAP).

## 📁 Estructura del proyecto

```
sap-fiori-mcp-server/
├── src/
│   ├── index.ts          # CLI: stdio / HTTP / --help
│   ├── server.ts         # Factoría McpServer + registro de tools + recursos
│   ├── http.ts           # Transporte HTTP Streamable (stateless, API key, CORS)
│   ├── config.ts         # Variables de entorno y sistemas SAP
│   ├── logger.ts         # Log a archivo (nunca stdout)
│   ├── tools/            # Registro de las 26 tools (doc/fiori/ui5/cap/btp)
│   ├── fiori/            # apps, generación (5 floorplans FE), funcionalidades
│   ├── ui5/              # scaffold (5 plantillas), cards, api, versions, project, validate, linter
│   ├── cap/              # parser CDS, modelo, motor de queries CSV
│   ├── btp/              # destinations: env/archivos/Destination Service, auth OAuth2/Basic
│   ├── odata/            # cliente OData V2/V4 + parser EDMX
│   ├── util/             # fs seguro, búsqueda TF-IDF, helpers XML
│   └── docs/             # corpus documental integrado
├── examples/bookshop/    # Proyecto CAP demo (db + srv + datos CSV)
├── test/                 # 243 tests (Vitest) con transport in-memory
├── docs/AGENTS-rules.md  # Reglas para el modelo de IA
├── docs/NPM-PUBLISH.md   # Guía de publicación en npm
├── Dockerfile            # Multi-stage, node:22-alpine
└── .vscode/launch.json   # Debug con breakpoints (stdio y HTTP)
```

## 🧪 Desarrollo

```bash
npm run build       # tsc → dist/
npm run typecheck   # tsc --noEmit
npm test            # vitest run (243 tests)
npm run test:watch  # vitest watch
```

**Evaluación del servidor**: [`eval/evaluation.xml`](./eval/evaluation.xml) contiene 10 preguntas de
solo lectura que miden si un modelo puede resolver tareas reales con estas tools y nada más
(instrucciones en [`eval/README.md`](./eval/README.md)). `npm test -- evaluation-answers` recalcula
cada respuesta llamando a las tools, para que la evaluación no se quede obsoleta si cambia el
proyecto de ejemplo.

Debug: abre la carpeta en VS Code y usa las configuraciones de `.vscode/launch.json` («MCP server (stdio)» y «MCP server (HTTP :3001)»).

## 🆚 Diferencias con los servidores oficiales

| Aspecto | Servidores oficiales | Este servidor |
|---|---|---|
| Búsqueda documental | Embeddings locales (modelo ~86 MB en `fiori-mcp-server`) | TF-IDF sobre corpus integrado, sin descargas |
| Modelo CDS | `@cap-js/cds` compilado | Parser CDS propio (entidades, servicios, aspectos, anotaciones) |
| API reference UI5 | `@ui5/dts-tooling` + CDN | Type definitions oficiales por CDN con caché |
| Transporte | stdio | stdio + HTTP Streamable con API key |
| BTP | — | Destinations locales + Destination Service + `query_odata_data` |
| Instalación | `npx` (descarga paquete npm) | `npx @pired/sap-fiori-mcp-server`, build local o Docker |
| Extras | — | `get_metadata_summary`, `get_cap_details`, `query_cap_data`, proyectos demo |

## 📄 Licencia

MIT — ver [LICENSE](./LICENSE).
