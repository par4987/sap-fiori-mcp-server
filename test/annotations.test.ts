/**
 * Fetching the annotation document a V2 service keeps outside its $metadata.
 *
 * What matters is that a service with annotations gets them, and that everything else — no catalog,
 * no authorisation, an empty annotation model — leaves app generation working rather than failing.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchAnnotationDocuments } from "../src/odata/annotations.js";

const BASE = "https://abap.example.com";
const SVC = "/sap/opu/odata/sap/ZUI_FE_BOOKING_000110_O2";

const ANNOTATED = `<?xml version="1.0"?><edmx:Edmx xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx"><edmx:DataServices><Schema xmlns="http://docs.oasis-open.org/odata/ns/edm" Namespace="van.v1">
<Annotations Target="svc.TravelType"><Annotation Term="UI.LineItem"/></Annotations></Schema></edmx:DataServices></edmx:Edmx>`;
const REFERENCES_ONLY = `<?xml version="1.0"?><edmx:Edmx xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx"><edmx:Reference Uri="../voc"><edmx:Include Namespace="com.sap.vocabularies.UI.v1" Alias="UI"/></edmx:Reference></edmx:Edmx>`;

function reply(body: string, status = 200, json = false): Response {
  return { ok: status < 300, status, text: async () => body, json: async () => JSON.parse(body) } as unknown as Response;
}

const catalogEntry = (name: string) =>
  JSON.stringify({ d: { results: [{ TechnicalName: name, __metadata: { media_src: `/sap/opu/odata/IWFND/CATALOGSERVICE;v=2/Annotations('${name}')/$value` } }] } });

afterEach(() => vi.unstubAllGlobals());

describe("annotation documents of a V2 service", () => {
  it("asks the catalog for the service's own annotations and reads them", async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        seen.push(String(url));
        if (String(url).includes("/Annotations?")) return reply(catalogEntry("ZUI_FE_BOOKING_000110_O2_VAN"), 200, true);
        return reply(ANNOTATED);
      })
    );
    const docs = await fetchAnnotationDocuments(BASE, SVC, { authorization: "Bearer t" });
    expect(docs).toHaveLength(1);
    expect(docs[0].technicalName).toBe("ZUI_FE_BOOKING_000110_O2_VAN");
    expect(docs[0].xml).toContain("UI.LineItem");
    // the catalog keys a service by technical name plus version, and guessing that wrong finds nothing
    expect(seen[0]).toContain("ServiceCollection('ZUI_FE_BOOKING_000110_O2_0001')");
  });

  it("ignores a document that only references vocabularies", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        String(url).includes("/Annotations?") ? reply(catalogEntry("EMPTY_VAN"), 200, true) : reply(REFERENCES_ONLY)
      )
    );
    // declaring a data source that describes nothing helps no one
    expect(await fetchAnnotationDocuments(BASE, SVC, {})).toEqual([]);
  });

  it("returns nothing rather than throwing when the catalog refuses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply("forbidden", 403)));
    expect(await fetchAnnotationDocuments(BASE, SVC, {})).toEqual([]);
  });

  it("returns nothing rather than throwing when the system has no catalog at all", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ENOTFOUND"); }));
    expect(await fetchAnnotationDocuments(BASE, SVC, {})).toEqual([]);
  });
});

// The request for each document carries this system's credentials, and the catalog response names
// where the document lives. A response must not be able to send those credentials anywhere else.
describe("where an annotation document is fetched from", () => {
  const catalogPointingAt = (mediaSrc: string) =>
    JSON.stringify({ d: { results: [{ TechnicalName: "ZANNO", __metadata: { media_src: mediaSrc } }] } });

  it("never sends the credentials to a host the catalog names", async () => {
    const seen: { url: string; auth?: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const u = String(url);
        seen.push({ url: u, auth: (init?.headers as Record<string, string>)?.authorization });
        return u.includes("CATALOGSERVICE") && u.includes("/Annotations?")
          ? reply(catalogPointingAt("https://evil.example.net/steal/Annotations('ZANNO')/$value?x=1"), 200, true)
          : reply(ANNOTATED);
      })
    );

    const docs = await fetchAnnotationDocuments(BASE, SVC, { authorization: "Basic c2VjcmV0" });

    expect(seen.some((s) => s.url.includes("evil.example.net"))).toBe(false);
    for (const s of seen) expect(new URL(s.url).origin).toBe(BASE);
    // the path survives, so a Gateway behind a proxy that advertises its internal host still works
    expect(docs[0].url).toBe(`${BASE}/steal/Annotations('ZANNO')/$value?x=1`);
  });

  it("leaves an absolute URL on our own origin exactly as it was", async () => {
    const own = `${BASE}/sap/opu/odata/IWFND/CATALOGSERVICE;v=2/Annotations('ZANNO')/$value`;
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        const u = String(url);
        seen.push(u);
        return u.includes("/Annotations?") ? reply(catalogPointingAt(own), 200, true) : reply(ANNOTATED);
      })
    );

    const docs = await fetchAnnotationDocuments(BASE, SVC, {});
    expect(seen[1]).toBe(own);
    expect(docs[0].url).toBe(own);
  });
});
