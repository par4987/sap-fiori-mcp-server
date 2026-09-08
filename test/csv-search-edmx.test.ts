import { describe, it, expect } from "vitest";
import { extractRows } from "../src/odata/client.js";
import { queryCsv } from "../src/cap/csv.js";
import { searchDocs, fuzzyNameScore } from "../src/util/search.js";
import { searchAllDocs } from "../src/docs/index.js";
import { parseEdmx } from "../src/odata/edmx.js";

const CSV = `ID,title,stock,price,active
550e8400-e29b-41d4-a716-446655440001,Cat,10,15.50,true
550e8400-e29b-41d4-a716-446655440002,Dog,0,25.00,false
550e8400-e29b-41d4-a716-446655440003,Catalog,7,8.75,true
`;

describe("queryCsv", () => {
  it("returns all rows", () => {
    const r = queryCsv(CSV, "data.csv", {});
    expect(r.count).toBe(3);
    expect(r.rows[0].title).toBe("Cat");
    expect(typeof r.rows[0].stock).toBe("number");
  });

  it("filters with gt and eq", () => {
    const r = queryCsv(CSV, "data.csv", { filter: "stock gt 1" });
    expect(r.count).toBe(2);
    const r2 = queryCsv(CSV, "data.csv", { filter: "active = true" });
    expect(r2.count).toBe(2);
  });

  it("supports and/or + contains", () => {
    const r = queryCsv(CSV, "data.csv", { filter: "contains(title, 'Cat') and price lt 10" });
    expect(r.count).toBe(1);
    expect(r.rows[0].title).toBe("Catalog");
    const or = queryCsv(CSV, "data.csv", { filter: "title eq 'Dog' or price lt 10" });
    expect(or.count).toBe(2);
  });

  it("projects columns and paginates", () => {
    const r = queryCsv(CSV, "data.csv", { columns: ["title", "price"], orderBy: [{ column: "price", desc: true }], limit: 2, skip: 1 });
    expect(r.rows[0].title).toBe("Cat");
    expect(r.rows[0].stock).toBeUndefined();
  });
});

describe("fuzzyNameScore", () => {
  it("ranks exact, prefix, substring", () => {
    expect(fuzzyNameScore("Books", "my.bookshop.Books")).toBeGreaterThan(90);
    expect(fuzzyNameScore("book", "my.bookshop.Books")).toBeGreaterThan(40);
    expect(fuzzyNameScore("Authors", "my.bookshop.Books")).toBe(0);
  });
});

describe("searchDocs", () => {
  it("finds fiori docs about FCL", () => {
    const hits = searchAllDocs("flexible column layout", 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].id).toBe("fe-fcl");
  });
  it("scopes corpora", () => {
    const hits = searchAllDocs("draft enabled entity managed", 20, "cap");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.corpus === "cap")).toBe(true);
  });
});

const METADATA = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx" Version="4.0">
  <edmx:DataServices>
    <Schema xmlns="http://docs.oasis-open.org/odata/ns/edm" Namespace="ns.travel">
      <EntityType Name="Travel">
        <Key><PropertyRef Name="ID"/></Key>
        <Property Name="ID" Type="Edm.String"/>
        <Property Name="TravelUUID" Type="Edm.Guid"/>
        <NavigationProperty Name="_Agency" Type="ns.travel.Agency"/>
      </EntityType>
      <EntityType Name="Agency">
        <Key><PropertyRef Name="AgencyID"/></Key>
        <Property Name="AgencyID" Type="Edm.String"/>
      </EntityType>
      <EntityContainer Name="Container">
        <EntitySet Name="Travel" EntityType="ns.travel.Travel">
          <NavigationPropertyBinding Path="_Agency" Target="Agency"/>
        </EntitySet>
        <EntitySet Name="Agency" EntityType="ns.travel.Agency"/>
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

describe("parseEdmx", () => {
  const model = parseEdmx(METADATA);
  it("detects version and namespaces", () => {
    expect(model.version).toBe("4.0");
    expect(model.namespaces).toContain("ns.travel");
  });
  it("extracts entity types with keys and navprops", () => {
    const travel = model.entityTypes.find((t) => t.name === "Travel")!;
    expect(travel.keys).toEqual(["ID"]);
    expect(travel.navigationProperties[0].name).toBe("_Agency");
  });
  it("extracts entity sets with navigation bindings", () => {
    const travelSet = model.entitySets.find((s) => s.name === "Travel")!;
    expect(travelSet.entityType).toBe("ns.travel.Travel");
    expect(travelSet.navigations["_Agency"]).toBe("Agency");
  });
});

// Response shapes taken from live services.odata.org calls: the V2 endpoint switches `d` from an
// object with `results` to a bare array once $expand is in play, which used to yield one "row"
// that was actually the whole array.
describe("extractRows across real OData response shapes", () => {
  it("reads a V4 collection and its @odata.count", () => {
    expect(extractRows({ value: [{ ID: 1 }, { ID: 2 }], "@odata.count": 7 })).toEqual({ rows: [{ ID: 1 }, { ID: 2 }], inlineCount: 7 });
  });

  it("reads a V2 collection and its string __count", () => {
    const r = extractRows({ d: { results: [{ ID: 1 }], __count: "42" } });
    expect(r.rows).toEqual([{ ID: 1 }]);
    expect(r.inlineCount).toBe(42);
  });

  it("reads a V2 payload where d is the array itself", () => {
    const r = extractRows({ d: [{ OrderID: 10248 }, { OrderID: 10249 }] });
    expect(r.rows).toEqual([{ OrderID: 10248 }, { OrderID: 10249 }]);
  });

  it("reads a V2 single entity", () => {
    expect(extractRows({ d: { ID: 1, title: "x" } }).rows).toEqual([{ ID: 1, title: "x" }]);
  });

  it("returns nothing for an empty or unknown payload", () => {
    expect(extractRows(undefined).rows).toEqual([]);
    expect(extractRows({}).rows).toEqual([]);
  });
});
