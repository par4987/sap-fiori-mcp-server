# Evaluación del servidor MCP

`evaluation.xml` contiene 10 preguntas que miden lo único que importa de un servidor MCP: si un
modelo **sin más contexto que estas tools** puede resolver tareas realistas. No miden cuántas tools
hay, sino si sus descripciones, esquemas y errores guían al modelo hasta la respuesta.

Todas las preguntas:

- son **de solo lectura** (ninguna necesita crear, modificar ni borrar nada),
- son **independientes** entre sí,
- tienen **una única respuesta verificable por comparación de cadenas**,
- son **estables**: se resuelven contra el proyecto CAP incluido en [`examples/bookshop`](../examples/bookshop),
  que no cambia.

Casi ninguna se resuelve con una sola llamada: la mayoría exige encadenar el modelo CDS, los datos
CSV y el corpus de documentación (p. ej. cruzar `query_cap_data` sobre tres CSV distintos, o
combinar una anotación del servicio con lo que dice la documentación sobre cómo CAP publica OData V4).

## Ejecutar

El harness (`evaluation.py`) viene con la skill `mcp-builder` de Anthropic, no con este repo. Consume
tu propia API key de la API de Anthropic: no vale la sesión de Claude Code.

```bash
python -m venv ~/.mcpeval
~/.mcpeval/Scripts/python -m pip install "anthropic>=0.39.0" "mcp>=1.1.0,<2"
export ANTHROPIC_API_KEY=...
```

Dos cosas que cuestan tiempo si no las sabes, comprobadas en Windows:

- **Fija `mcp<2`.** El harness importa `streamablehttp_client`, que la 2.x renombró a
  `streamable_http_client`. Con `mcp` 2.x falla al importar *incluso en modo stdio*.
- **Crea el venv en una ruta corta** (`~/.mcpeval`, no dentro de una carpeta anidada). El paquete
  `anthropic` trae nombres de fichero muy largos y sin *long path support* la instalación revienta
  a medias, dejando el paquete corrupto.

El servidor **debe** apuntar al proyecto de ejemplo, o las respuestas no serán reproducibles. El
modelo por defecto del harness es antiguo, así que conviene pasarlo explícito:

```bash
~/.mcpeval/Scripts/python <ruta-a-la-skill>/scripts/evaluation.py -t stdio -m claude-sonnet-5 -c node -a "$PWD/dist/index.js" -e SAP_FIORI_MCP_WORKSPACE_ROOT="$PWD/examples/bookshop" -e LOG_LEVEL=off -o eval/report.md eval/evaluation.xml
```

En modo stdio el harness arranca y para el servidor por sí mismo: no lo lances tú aparte. Ejecuta
`npm run build` antes, porque lo que se evalúa es `dist/`, no `src/`.

## Comprobar que las respuestas siguen siendo válidas

Las respuestas se derivan de los datos de ejemplo, así que envejecen si alguien toca
`examples/bookshop`. [`test/evaluation-answers.test.ts`](../test/evaluation-answers.test.ts) vuelve a
calcular cada respuesta llamando a las tools reales y la compara con el XML:

```bash
npm test -- evaluation-answers
```

Si ese test falla, primero corrige `evaluation.xml`; no toques el test para que pase.

## Cobertura

Las 10 preguntas ejercitan `search_docs`, `search_model`, `get_cap_details` y `query_cap_data`.
Quedan fuera las tools que escriben (`generate_fiori_app_*`, `create_ui5_app`,
`execute_functionality`, `download_odata_service_metadata`) porque la evaluación es de solo lectura,
y las que necesitan una app Fiori ya existente o un sistema SAP remoto (`list_functionality`,
`run_ui5_linter`, `query_odata_data`), que el proyecto de ejemplo no incluye.
