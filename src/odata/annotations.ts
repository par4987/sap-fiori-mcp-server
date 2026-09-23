/**
 * The UI annotations of a V2 service, which usually do not live in its $metadata.
 *
 * A V4 service carries its annotations inline, so a generator that reads $metadata sees everything.
 * Gateway splits them: the service describes its shape and a separate annotation document — one per
 * annotation model, registered in the catalog — says what to show. An app generated without it gets
 * a list with no columns, which is the failure mode SAP Fiori tools avoids by fetching the document
 * and declaring it as a second data source.
 *
 * The catalog is asked rather than guessed at: the annotation entry's key encodes a version and an
 * origin this tool has no business inventing, and the entry hands back the URL to read.
 */
import { logger } from "../logger.js";

export interface AnnotationDocument {
  /** Catalog name, e.g. ZUI_FE_BOOKING_000110_O2_VAN — also the local file name. */
  technicalName: string;
  /** Absolute URL the document was read from. */
  url: string;
  xml: string;
}

/** The catalog id of a service: the technical name plus its version, as ServiceCollection keys it. */
function serviceCollectionKey(servicePath: string): string | null {
  // .../sap/opu/odata/sap/ZUI_FE_BOOKING_000110_O2  ->  ZUI_FE_BOOKING_000110_O2_0001
  const last = servicePath.replace(/[?#].*$/, "").replace(/\/+$/, "").split("/").pop() ?? "";
  if (!last) return null;
  return /_\d{4}$/.test(last) ? last : `${last}_0001`;
}

interface CatalogAnnotationEntry {
  TechnicalName?: string;
  __metadata?: { media_src?: string; uri?: string };
}

/**
 * Where to fetch one annotation document, always on the origin we were given.
 *
 * The catalog names each document's location, and the request for it carries this system's
 * credentials. An absolute URL on another host would take those credentials wherever a network
 * response pointed, so a foreign host keeps only its path, mounted on our origin. That is also the
 * right answer for the ordinary case: a Gateway behind a Web Dispatcher advertises its internal
 * host name, which the caller usually cannot even resolve.
 */
export function documentUrl(root: string, src: string): string {
  if (!/^https?:\/\//i.test(src)) return `${root}/${src.replace(/^\//, "")}`;
  const abs = new URL(src);
  const origin = new URL(root).origin;
  if (abs.origin === origin) return abs.toString();
  logger.info("Annotation document advertised on another host; fetching its path from ours", { advertised: abs.origin, using: origin });
  return `${origin}${abs.pathname}${abs.search}`;
}

/**
 * Every annotation document a V2 service declares, already fetched.
 *
 * Best effort by design: a system with no catalog, a service registered without annotations, or a
 * user without catalog authorisation are all ordinary, and none of them should stop an app from
 * being generated. The caller is told what was found, not what was attempted.
 */
export async function fetchAnnotationDocuments(
  baseUrl: string,
  servicePath: string,
  headers: Record<string, string>,
  timeoutMs = 30000
): Promise<AnnotationDocument[]> {
  const key = serviceCollectionKey(servicePath);
  if (!key) return [];
  const root = baseUrl.replace(/\/+$/, "");
  const catalog = `${root}/sap/opu/odata/IWFND/CATALOGSERVICE;v=2/ServiceCollection('${encodeURIComponent(key)}')/Annotations?$format=json`;

  let entries: CatalogAnnotationEntry[];
  try {
    const res = await fetch(catalog, { headers: { ...headers, accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) {
      logger.info("No annotation documents from the catalog", { status: res.status, service: key });
      return [];
    }
    const body = (await res.json()) as { d?: { results?: CatalogAnnotationEntry[] } };
    entries = body.d?.results ?? [];
  } catch (e) {
    logger.info("Annotation catalog lookup failed", { service: key, error: String(e) });
    return [];
  }

  const out: AnnotationDocument[] = [];
  for (const entry of entries) {
    const src = entry.__metadata?.media_src ?? (entry.__metadata?.uri ? `${entry.__metadata.uri}/$value` : undefined);
    if (!src) continue;
    const url = documentUrl(root, src);
    try {
      const res = await fetch(url, { headers: { ...headers, accept: "application/xml" }, signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) continue;
      const xml = await res.text();
      // an annotation model registered but never filled in is common; a file of pure vocabulary
      // references adds a data source that describes nothing
      if (!/<Annotations?\s/i.test(xml)) {
        logger.info("Annotation document carries no annotations", { name: entry.TechnicalName, url });
        continue;
      }
      out.push({ technicalName: entry.TechnicalName ?? `annotations${out.length + 1}`, url, xml });
    } catch (e) {
      logger.info("Could not read an annotation document", { url, error: String(e) });
    }
  }
  return out;
}
