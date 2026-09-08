/**
 * Output schemas for the registered tools.
 *
 * Every tool declares one, so clients receive `structuredContent` they can process without
 * re-parsing the text block. Deeply nested, source-dependent structures (a parsed manifest, a
 * CDS definition, an OData row) stay `unknown`: declaring them precisely would misrepresent
 * what an arbitrary SAP project can contain, and a schema mismatch fails the call at runtime.
 */
import { z } from "zod";

/** Objects that carry extra, source-dependent keys must not be stripped. */
const loose = <T extends z.ZodRawShape>(shape: T) => z.object(shape).passthrough();

const row = z.record(z.unknown());

export const paginationShape = {
  count: z.number().int().describe("Items returned in this response"),
  total: z.number().int().describe("Total items matching the request"),
  offset: z.number().int().describe("Offset of the first returned item"),
  hasMore: z.boolean().describe("True when more items are available"),
  nextOffset: z.number().int().nullable().describe("Offset to request next, or null on the last page")
};

// --- docs -------------------------------------------------------------------

export const searchDocsOutput = {
  query: z.string(),
  scope: z.string(),
  ...paginationShape,
  results: z.array(
    loose({
      id: z.string(),
      corpus: z.string(),
      title: z.string(),
      tags: z.array(z.string()),
      score: z.number(),
      snippet: z.string(),
      body: z.string()
    })
  )
};

export const guidelinesOutput = {
  topic: z.string().optional(),
  title: z.string(),
  content: z.string()
};

// --- fiori ------------------------------------------------------------------

export const appSummary = loose({
  path: z.string(),
  appId: z.string(),
  title: z.string(),
  type: z.string(),
  entitySet: z.string().optional(),
  odataVersion: z.string().optional(),
  views: z.array(z.string()),
  hasFcl: z.boolean()
});

export const listFioriAppsOutput = {
  path: z.string(),
  name: z.string(),
  apps: z.array(appSummary),
  isCap: z.boolean(),
  hasPackageJson: z.boolean(),
  cdsFolders: loose({ db: z.boolean(), srv: z.boolean(), app: z.boolean() })
};

export const listSapSystemsOutput = {
  count: z.number().int(),
  systems: z.array(
    loose({ name: z.string(), url: z.string(), client: z.string().optional(), authType: z.string(), user: z.string().optional() })
  ),
  hint: z.string()
};

const entitySetSchema = loose({ name: z.string(), entityType: z.string().optional() });
const entityTypeSchema = loose({ name: z.string(), keys: z.array(z.string()).optional() });

export const metadataOutput = {
  savedTo: z.string().optional(),
  sourceUrl: z.string().optional(),
  odataVersion: z.string(),
  namespaces: z.array(z.string()),
  entitySets: z.array(entitySetSchema),
  entityTypes: z.array(entityTypeSchema),
  annotationTargets: z.array(z.string()).optional(),
  annotations: z.array(z.unknown()).optional()
};

export const generateAppOutput = {
  appPath: z.string(),
  createdFiles: z.array(z.string()),
  warnings: z.array(z.string()),
  nextSteps: z.array(z.string()),
  resolvedService: z.string().nullable().optional(),
  resolvedEntitySet: z.string().optional(),
  serviceUri: z.string().optional()
};

const parameterSchema = loose({ name: z.string(), type: z.string(), required: z.boolean(), description: z.string() });

const functionalitySchema = loose({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  parameters: z.array(parameterSchema)
});

export const listFunctionalityOutput = {
  app: appSummary,
  functionalities: z.array(functionalitySchema)
};

export const functionalityDetailsOutput = {
  id: z.string(),
  title: z.string(),
  description: z.string(),
  parameters: z.array(parameterSchema)
};

export const executeFunctionalityOutput = {
  changed: z.array(z.string()),
  created: z.array(z.string()),
  message: z.string()
};

// --- ui5 --------------------------------------------------------------------

export const scaffoldOutput = {
  appPath: z.string(),
  createdFiles: z.array(z.string()),
  nextSteps: z.array(z.string()).optional()
};

export const apiReferenceOutput = {
  control: z.string(),
  version: z.string(),
  reference: z.string(),
  truncated: z.boolean()
};

export const projectInfoOutput = {
  path: z.string(),
  name: z.string(),
  kind: z.string(),
  appId: z.string().optional(),
  appTitle: z.string().optional(),
  appType: z.string().optional(),
  framework: loose({ name: z.string(), minVersion: z.string().optional(), libs: z.array(z.string()).optional() }).optional(),
  manifestPath: z.string().optional(),
  ui5Yaml: z.string().optional(),
  views: z.array(z.string()).optional(),
  controllers: z.array(z.string()).optional(),
  models: row.optional(),
  routing: z.unknown().optional(),
  dataSources: z.unknown().optional(),
  packageScripts: z.array(z.string()).optional(),
  cdsServices: z.array(z.string()).optional(),
  apps: z.array(loose({ path: z.string(), id: z.string(), type: z.string() })).optional()
};

export const versionInfoOutput = {
  distribution: z.string(),
  latest: z.string().nullable(),
  libraries: z.array(loose({ name: z.string(), version: z.string() })).optional(),
  localProjectVersion: z.string().nullable().optional(),
  source: z.string(),
  note: z.string().optional()
};

export const manifestValidationOutput = {
  valid: z.boolean(),
  errors: z.number().int(),
  warnings: z.number().int(),
  issues: z.array(loose({ severity: z.string(), rule: z.string(), message: z.string(), path: z.string().optional() })),
  manifestPath: z.string()
};

export const linterOutput = {
  issues: z.array(loose({ severity: z.string(), file: z.string(), line: z.number().optional(), rule: z.string(), message: z.string() })),
  filesScanned: z.number().int()
};

// --- cap --------------------------------------------------------------------

export const searchModelOutput = {
  sourcesParsed: z.number().int(),
  namespaces: z.array(z.string()),
  totalDefinitions: z.number().int(),
  ...paginationShape,
  results: z.array(
    loose({
      name: z.string(),
      shortName: z.string(),
      kind: z.string(),
      score: z.number(),
      source: z.string(),
      line: z.number()
    })
  )
};

export const capDetailsOutput = {
  name: z.string(),
  shortName: z.string(),
  kind: z.string(),
  source: z.string().optional(),
  line: z.number().int().optional(),
  namespace: z.string().optional(),
  projectionOn: z.string().optional(),
  includes: z.array(z.string()).optional(),
  annotations: z.record(z.string()).optional(),
  elements: z
    .array(
      loose({
        name: z.string(),
        type: z.string(),
        kind: z.string(),
        target: z.string().optional().describe("Association/composition target entity"),
        cardinality: z.string().optional().describe("'one' or 'many'")
      })
    )
    .optional(),
  actions: z
    .array(
      loose({
        name: z.string(),
        type: z.string().describe("Return type, or 'empty' when the operation returns nothing"),
        kind: z.string().describe("'action' or 'function'"),
        returnsMany: z.boolean().optional().describe("True when it returns a collection"),
        params: z
          .array(loose({ name: z.string(), type: z.string(), array: z.boolean().optional(), default: z.string().optional() }))
          .optional()
          .describe("Declared parameters, in order")
      })
    )
    .optional(),
  exposedByServices: z.array(loose({ service: z.string(), exposed: z.array(z.unknown()) }))
};

export const queryCapDataOutput = {
  file: z.string(),
  columns: z.array(z.string()),
  rows: z.array(row),
  count: z.number().int().describe("Rows in this response"),
  total: z.number().int().describe("Rows matching the filter, before skip/limit"),
  skip: z.number().int(),
  limit: z.number().int(),
  hasMore: z.boolean(),
  nextSkip: z.number().int().nullable().describe("Value to pass as skip on the next call, or null")
};

// --- btp --------------------------------------------------------------------

const destinationSchema = loose({ name: z.string(), url: z.string(), authType: z.string(), source: z.string() });

export const listDestinationsOutput = {
  count: z.number().int(),
  destinations: z.array(destinationSchema),
  destinationServiceConfigured: z.boolean(),
  destinationService: loose({ count: z.number().int(), destinations: z.array(destinationSchema) }).optional(),
  destinationServiceError: z.string().optional(),
  hint: z.string()
};

export const getDestinationOutput = {
  destination: destinationSchema,
  auth: row,
  usage: row
};

export const queryODataOutput = {
  source: z.string(),
  appliedUrl: z.string(),
  rows: z.array(z.unknown()),
  count: z.number().int().describe("Rows in this response"),
  rowCount: z.number().int().describe("Deprecated alias of count; use count"),
  total: z.number().int().optional().describe("Total rows reported by the service (only when count:true was requested)"),
  inlineCount: z.number().int().optional().describe("Raw $count value reported by the service"),
  truncatedTo: z.number().int().optional().describe("Set when the service returned more rows than maxRows"),
  hasMore: z.boolean(),
  nextSkip: z.number().int().nullable().describe("Value to pass as skip on the next call, or null"),
  destination: row.optional()
};
