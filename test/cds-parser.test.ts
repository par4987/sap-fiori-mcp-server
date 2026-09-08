import { describe, it, expect } from "vitest";
import { parseCdsSources, parseBody, stripCdsComments } from "../src/cap/cds-parser.js";

const SAMPLE_CDS = `
namespace my.bookshop;

using { Currency, managed, cuid } from '@sap/cds/common';

// a comment
entity Books : managed {
  key ID      : UUID;
  title       : String(111) @title('Title');
  descr       : String @default 'n/a';
  stock       : Integer not null;
  price       : Decimal(9,2);
  author      : Association to Authors;
  genre       : Association to many Genres on genre.code = $self;
}

entity Authors : managed {
  key ID : UUID;
  name   : String(111);
  books  : Association to many Books on books.author = $self;
  /* block
     comment */
}

aspect Person { name : String(100); }

type BookType { title : String; price : Decimal(9,2); }

@readonly
entity BestSellers as projection on Books;

service CatalogService @(path:'/browse') {
  @requires: 'authenticated-user'
  entity Books as projection on my.bookshop.Books;
  entity Authors as select from my.bookshop.Authors { * , books : redirected to Authors };

  action submitOrder(book: Books:ID, quantity: Integer) returns Decimal;
  function topAuthors(n: Integer) returns array of Authors;
}

annotate Books with {
  title @UI.LineItem: [{ position: 10 }];
}
`;

describe("stripCdsComments", () => {
  it("removes line and block comments", () => {
    const out = stripCdsComments("entity A { x : Integer; } // end\n/* block */ entity B {};");
    expect(out).not.toContain("// end");
    expect(out).not.toContain("block");
    expect(out).toContain("entity A");
    expect(out).toContain("entity B");
  });
});

describe("parseBody", () => {
  it("parses elements with types and annotations", () => {
    const { elements } = parseBody("key ID : UUID; title : String(111) @title('T'); stock : Integer not null;");
    expect(elements.map((e) => e.name)).toEqual(["ID", "title", "stock"]);
    expect(elements[0].type).toBe("UUID");
    expect(elements[1].annotations["title"]).toBe("T");
    expect(elements[2].notNull).toBe(true);
  });

  it("parses associations and compositions", () => {
    const { elements } = parseBody("author : Association to Authors; items : Composition of many Items on items.parent = $self; genres : Association to many Genres on genres.code = $self;");
    expect(elements[0]).toMatchObject({ kind: "association", target: "Authors", cardinality: "one" });
    expect(elements[1]).toMatchObject({ kind: "composition", target: "Items", cardinality: "many" });
    expect(elements[2]).toMatchObject({ kind: "association", target: "Genres", cardinality: "many", on: "genres.code = $self" });
  });

  it("parses actions and functions", () => {
    const { actions } = parseBody("action submitOrder(book: Integer) returns Decimal; function top(n: Integer) returns array of Books;");
    expect(actions).toHaveLength(2);
    expect(actions[0]).toMatchObject({ name: "submitOrder", kind: "action", type: "Decimal" });
    expect(actions[1].kind).toBe("function");
  });
});

describe("parseCdsSources", () => {
  const model = parseCdsSources([{ path: "db/schema.cds", content: SAMPLE_CDS }]);

  it("extracts namespace", () => {
    expect(model.namespaces).toContain("my.bookshop");
  });

  it("extracts usings", () => {
    expect(model.usings[0].imports).toEqual(["Currency", "managed", "cuid"]);
  });

  it("finds entities with elements", () => {
    const books = model.definitions.find((d) => d.name === "my.bookshop.Books");
    expect(books).toBeDefined();
    expect(books!.kind).toBe("entity");
    expect(books!.elements.map((e) => e.name)).toContain("title");
    expect(books!.elements.find((e) => e.name === "author")!.target).toBe("Authors");
    expect(books!.namespace).toBe("my.bookshop");
  });

  it("finds aspects and types", () => {
    expect(model.definitions.find((d) => d.shortName === "Person")!.kind).toBe("aspect");
    expect(model.definitions.find((d) => d.shortName === "BookType")!.kind).toBe("type");
  });

  it("marks projections as views", () => {
    const best = model.definitions.find((d) => d.shortName === "BestSellers");
    expect(best!.kind).toBe("view");
    expect(best!.projectionOn).toBe("Books");
    expect(best!.annotations["readonly"]).toBeDefined();
  });

  it("extracts service with nested projections and actions", () => {
    const svc = model.definitions.find((d) => d.shortName === "CatalogService");
    expect(svc).toBeDefined();
    expect(svc!.kind).toBe("service");
    expect(svc!.actions.map((a) => a.name)).toContain("submitOrder");
    expect(svc!.actions.map((a) => a.name)).toContain("topAuthors");
    // nested service entities become service-qualified views
    const svcBooks = model.definitions.find((d) => d.name === "CatalogService.Books");
    expect(svcBooks).toBeDefined();
    expect(svcBooks!.projectionOn).toBe("my.bookshop.Books");
  });

  it("attaches annotate blocks to definitions", () => {
    const books = model.definitions.find((d) => d.name === "my.bookshop.Books")!;
    expect(books.elements.find((e) => e.name === "title")!.annotations["UI.LineItem"]).toBeDefined();
  });

  it("survives malformed input", () => {
    const bad = parseCdsSources([{ path: "bad.cds", content: "entity Broken { x : ;;;" }]);
    expect(Array.isArray(bad.definitions)).toBe(true);
  });
});

describe("grouped annotations and nested projections", () => {
  const src = `namespace my.shop;

service CatalogService @(path: '/browse', requires: 'authenticated-user') {

  @readonly entity Books as projection on my.shop.Books {
    *,
    author.name as authorName
  };

  @readonly entity Authors as projection on my.shop.Authors;
}
`;

  // @(path: '...') decides the OData URL of a CAP service, and generate_fiori_app_cap reads it
  it("parses the grouped @(...) annotation form on a service", () => {
    const model = parseCdsSources([{ path: "srv/cat-service.cds", content: src }]);
    const service = model.definitions.find((d) => d.name === "CatalogService");
    expect(service?.annotations["path"]).toBe("/browse");
    expect(service?.annotations["requires"]).toBe("authenticated-user");
  });

  it("keeps annotations and real line numbers for entities nested in a service", () => {
    const model = parseCdsSources([{ path: "srv/cat-service.cds", content: src }]);
    const books = model.definitions.find((d) => d.name === "CatalogService.Books");
    const authors = model.definitions.find((d) => d.name === "CatalogService.Authors");
    expect(books?.annotations).toHaveProperty("readonly");
    expect(books?.projectionOn).toBe("my.shop.Books");
    expect(books?.line).toBe(5);
    expect(authors?.line).toBe(10);
  });

  // "using { sap.demo.bookshop as bookshop }" makes every reference written through the alias a
  // dead end for anyone walking the model, unless the alias is expanded back to its full path
  it("expands using aliases in projection targets", () => {
    const aliased = `using { my.long.namespace as shop } from '../db/schema';

service CatalogService {
  entity Books as projection on shop.Books;
  entity Sales as select from shop.Orders;
  entity Local as projection on Something;
}
`;
    const model = parseCdsSources([{ path: "srv/s.cds", content: aliased }]);
    const byName = Object.fromEntries(model.definitions.map((d) => [d.name, d]));
    expect(byName["CatalogService.Books"].projectionOn).toBe("my.long.namespace.Books");
    expect(byName["CatalogService.Sales"].projectionOn).toBe("my.long.namespace.Orders");
    // a bare name has no alias to expand and must be left untouched
    expect(byName["CatalogService.Local"].projectionOn).toBe("Something");
  });

  it("reports source paths with forward slashes", () => {
    const model = parseCdsSources([{ path: "srv/cat-service.cds", content: src }]);
    expect(model.definitions.every((d) => !d.source.includes("\\"))).toBe(true);
  });
});

describe("action and function signatures", () => {
  const svc = `service AdminService {
  action submitOrder(book: Books:ID, quantity: Integer) returns Decimal;
  @Core.Description: 'resize'
  action rename(id: UUID, label: String(80), suffix: String(10) default 'v2') returns String(90);
  function findAll(filter: String, page: Integer default 0) returns array of Books;
  action reindex() returns Boolean;
  action importAll(rows: many Books) returns Integer;
  action noReturn(id: UUID);
}
`;
  const actions = () => {
    const model = parseCdsSources([{ path: "srv/admin.cds", content: svc }]);
    const def = model.definitions.find((d) => d.name === "AdminService")!;
    return Object.fromEntries(def.actions.map((a) => [a.name, a]));
  };

  it("captures every declared parameter with its type", () => {
    const submit = actions()["submitOrder"];
    expect(submit.kind).toBe("action");
    expect(submit.type).toBe("Decimal");
    expect(submit.params).toEqual([
      { name: "book", type: "Books:ID", annotations: {} },
      { name: "quantity", type: "Integer", annotations: {} }
    ]);
  });

  // a parameter type carrying its own parentheses used to make the whole action unparseable
  it("handles parameter types with parentheses and default values", () => {
    const rename = actions()["rename"];
    expect(rename).toBeDefined();
    expect(rename.type).toBe("String(90)");
    expect(rename.params?.map((p) => p.type)).toEqual(["UUID", "String(80)", "String(10)"]);
    expect(rename.params?.[2].default).toBe("v2");
    expect(rename.annotations["Core.Description"]).toBe("resize");
  });

  it("marks collection parameters and collection return types", () => {
    const all = actions();
    expect(all["findAll"].kind).toBe("function");
    expect(all["findAll"].returnsMany).toBe(true);
    expect(all["findAll"].type).toBe("Books");
    expect(all["importAll"].params?.[0]).toMatchObject({ name: "rows", type: "Books", array: true });
  });

  it("accepts an empty parameter list and a missing return type", () => {
    const all = actions();
    expect(all["reindex"].params).toEqual([]);
    expect(all["reindex"].type).toBe("Boolean");
    expect(all["noReturn"].type).toBe("empty");
    expect(all["noReturn"].params?.map((p) => p.name)).toEqual(["id"]);
  });
});
