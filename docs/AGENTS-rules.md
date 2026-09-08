# Reglas para creación o modificación de apps SAP Fiori con @pired/sap-fiori-mcp-server
# Copia estas reglas en AGENTS.md / CLAUDE.md / .cursorrules de tu proyecto.

## Reglas para creación o modificación de aplicaciones SAP Fiori elements

- Cuando te pidan crear una app SAP Fiori elements, comprueba si la entrada del usuario puede interpretarse como una aplicación organizada en una o más páginas con tablas o formularios (traducible a Fiori elements); si no, pide más detalles.
- Elige el floorplan adecuado en generate_fiori_app_odata / generate_fiori_app_cap: `list-report` (listado + Object Page, V4 y V2), `object-page` (form entry, solo V4), `worklist` (lista de tareas con carga inicial, V4 y V2), `analytical-list-page` (análisis con gráficos, solo V2) u `overview-page` (cards KPI, solo V2). Los combos no soportados se degradan a list-report con un warning.
- La aplicación típicamente empieza con una página List Report que muestra los datos de la entidad base en una tabla. Los detalles de una fila se muestran en un Object Page basado en esa misma entidad base.
- Un Object Page puede contener una o más secciones de tabla basadas en asociaciones to-many de su entidad. Los detalles de una fila de esas secciones pueden mostrarse en otro Object Page basado en la entidad destino de la asociación.
- El modelo de datos debe ser apto para un frontend Fiori elements: una entidad principal y una o más propiedades de navegación hacia entidades relacionadas. Usa search_model para verificarlo en proyectos CAP.
- Cada propiedad de una entidad debe tener un tipo de dato correcto.
- Para todas las entidades usa claves primarias de tipo UUID.
- Al crear datos de ejemplo en CSV, TODAS las claves primarias y foráneas deben ser UUID (p.ej. `550e8400-e29b-41d4-a716-446655440001`).
- Antes de generar o modificar una app Fiori elements usa search_docs para fundamentar tus decisiones en las guías.
- Para modificar una app existente (añadir páginas, extensiones de controlador, FCL, initial load) usa primero list_functionality → get_functionality_details → execute_functionality; no edites el manifest a mano si una functionality lo cubre.
- No uses personalización de pantalla para modificar la app: modifica el código del proyecto.
- Para previsualizar una app Fiori elements sobre CAP usa el script `npm run watch-*` más específico de la app en el package.json.

## Reglas generales de uso de las tools

- Las tools de búsqueda y consulta paginan: cuando la respuesta trae `hasMore: true`, vuelve a llamar con el `nextOffset` (search_docs, search_model) o `nextSkip` (query_cap_data, query_odata_data) devueltos, en lugar de subir el `limit`.
- Todas las respuestas incluyen `structuredContent` además del JSON en texto; usa los campos declarados en vez de reparsear el texto.

## Reglas para CAP (CDS)

- DEBES buscar definiciones CDS (entidades, campos, servicios y endpoints HTTP) con search_model; solo si falla puedes leer los ficheros *.cds directamente.
- DEBES consultar la documentación CAP con search_docs (scope: cap) SIEMPRE que crees o modifiques modelos CDS o uses APIs de CAP. No propongas cambios sin comprobarlo antes.
- Verifica los datos de ejemplo con query_cap_data en lugar de abrir los CSV a mano.

## Reglas para UI5

- Usa get_guidelines para recuperar los estándares de codificación UI5 antes de escribir código.
- Usa get_api_reference para consultar props/eventos/agregaciones de controles (p.ej. sap.m.Table) en lugar de inventar APIs.
- Tras generar o modificar un proyecto, valida con run_manifest_validation y revisa con run_ui5_linter.

## Reglas para SAP BTP y OData remoto

- Para leer datos de un sistema remoto usa query_odata_data (destination BTP, systemName o serviceUrl); es la contraparte remota de query_cap_data. Empieza por list_btp_destinations y verifica la autenticación con get_btp_destination.
- Para generar una app contra un servicio remoto: descarga primero la metadata con download_odata_service_metadata (acepta destination + servicePath) y pásala a generate_fiori_app_odata vía metadataXmlPath.
- Nunca muestres ni pidas secretos en el chat: password, clientSecret y tokens están redactados en las respuestas y se configuran solo por variables de entorno o archivos de destination.
- Los destinations admiten formato cockpit export (Name/URL/Authentication/...) o camelCase (name/url/authType/...); para el Destination Service en la nube se necesitan BTP_CLIENT_ID, BTP_CLIENT_SECRET, BTP_TOKEN_URL y BTP_DESTINATION_API_URL (o VCAP_SERVICES).
