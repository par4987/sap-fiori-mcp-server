import { findAttr, findElements } from "../util/xml.js";

export interface EdmxProperty {
  name: string;
  type: string;
  nullable?: boolean;
  label?: string;
  maxLength?: number;
  isKey: boolean;
}

export interface EdmxNavigationProperty {
  name: string;
  relationship?: string;
  type?: string;
  target?: string;
  containsTarget?: boolean;
  /** v2 style association end multiplicity resolved to "*"/"1" */
  many?: boolean;
}

export interface EdmxEntityType {
  name: string;
  keys: string[];
  properties: EdmxProperty[];
  navigationProperties: EdmxNavigationProperty[];
}

export interface EdmxEntitySet {
  name: string;
  entityType: string;
  navigations: Record<string, string>; // navProp name -> target entity set (v4 Binding or v2 navigation path)
}

export interface EdmxModel {
  version: "2.0" | "4.0";
  namespaces: string[];
  entityTypes: EdmxEntityType[];
  entitySets: EdmxEntitySet[];
  annotations: { target: string; qualifier?: string; terms: { term: string; value?: string }[] }[];
}

/**
 * Parse an EDMX document (OData V2 or V4) into a compact model.
 * Uses regex scanning rather than a full XML parser: metadata files are
 * machine generated and structurally stable.
 */
export function parseEdmx(xml: string): EdmxModel {
  // case-sensitive on purpose: avoid matching the lowercase version="1.0" of the <?xml?> declaration
  const versionMatch = /Version\s*=\s*["'](1\.0|2\.0|3\.0|4\.0)["']/.exec(xml);
  const rawVersion = versionMatch?.[1] ?? "4.0";
  const version: "2.0" | "4.0" = rawVersion === "2.0" || rawVersion === "1.0" ? "2.0" : "4.0";

  const namespaces = new Set<string>();
  for (const schema of findElements(xml, "Schema")) {
    const ns = findAttr(schema, "Namespace");
    if (ns) namespaces.add(ns);
  }

  // ---- Entity types ----
  const entityTypes: EdmxEntityType[] = [];
  for (const et of findElements(xml, "EntityType")) {
    const name = findAttr(et, "Name") ?? "Unknown";
    const keys: string[] = [];
    const keyContent = findElements(et.content, "Key")[0]?.content ?? "";
    for (const propRef of findElements(keyContent, "PropertyRef")) {
      const n = findAttr(propRef, "Name");
      if (n) keys.push(n);
    }
    const properties: EdmxProperty[] = [];
    for (const prop of findElements(et.content, "Property")) {
      const pname = findAttr(prop, "Name") ?? "";
      properties.push({
        name: pname,
        type: findAttr(prop, "Type") ?? "Edm.String",
        nullable: findAttr(prop, "Nullable") ? findAttr(prop, "Nullable") === "true" : undefined,
        label: findAttr(prop, "sap:label") ?? findAttr(prop, "label"),
        maxLength: findAttr(prop, "MaxLength") ? parseInt(findAttr(prop, "MaxLength")!, 10) : undefined,
        isKey: keys.includes(pname)
      });
    }
    const navigationProperties: EdmxNavigationProperty[] = [];
    for (const nav of findElements(et.content, "NavigationProperty")) {
      const navName = findAttr(nav, "Name") ?? "";
      const rel = findAttr(nav, "Relationship");
      let many = false;
      if (version === "2.0" && rel) {
        // resolve multiplicity from the association's end matching this nav property
        const assoc = findElements(xml, "Association").find((a) => findAttr(a, "Name") === rel.split(".").pop());
        if (assoc) {
          const ends = findElements(assoc.content, "End");
          const targetEnd = ends.find((e) => findAttr(e, "Role") && nav.content.includes(findAttr(e, "Role")!));
          many = ends.some((e) => (findAttr(e, "Multiplicity") ?? "").startsWith("*"));
          void targetEnd;
        }
      }
      navigationProperties.push({
        name: navName,
        relationship: rel,
        type: findAttr(nav, "Type"),
        target: findAttr(nav, "Target"),
        containsTarget: findAttr(nav, "ContainsTarget") === "true",
        many
      });
    }
    entityTypes.push({ name, keys, properties, navigationProperties });
  }

  // ---- Entity sets ----
  const entitySets: EdmxEntitySet[] = [];
  const containerContent = findElements(xml, "EntityContainer")[0]?.content ?? "";
  for (const es of findElements(containerContent, "EntitySet")) {
    const name = findAttr(es, "Name") ?? "";
    const entityType = findAttr(es, "EntityType") ?? "";
    const navigations: Record<string, string> = {};
    for (const navBinding of findElements(es.content, "NavigationPropertyBinding")) {
      const p = findAttr(navBinding, "Path");
      const t = findAttr(navBinding, "Target");
      if (p && t) navigations[p] = t;
    }
    entitySets.push({ name, entityType, navigations });
  }
  // V2: association sets resolve nav props to target entity sets
  if (version === "2.0") {
    for (const aset of findElements(containerContent, "AssociationSet")) {
      const ends = findElements(aset.content, "End");
      if (ends.length < 2) continue;
      const aSet = findAttr(ends[0], "EntitySet");
      const bSet = findAttr(ends[1], "EntitySet");
      if (!aSet || !bSet) continue;
      const source = entitySets.find((es) => es.name === aSet);
      if (source) {
        const etShort = source.entityType.split(".").pop()!;
        const et = entityTypes.find((t) => t.name === etShort);
        for (const nav of et?.navigationProperties ?? []) {
          if (nav.relationship?.endsWith(findAttr(aset, "Association") ?? "#")) {
            source.navigations[nav.name] = bSet;
          }
        }
      }
    }
  }

  // ---- Annotations (target + terms) ----
  const annotations: EdmxModel["annotations"] = [];
  for (const ann of findElements(xml, "Annotations")) {
    const target = findAttr(ann, "Target") ?? "";
    const qualifier = findAttr(ann, "Qualifier");
    const terms: { term: string; value?: string }[] = [];
    for (const rec of findElements(ann.content, "Annotation")) {
      terms.push({ term: findAttr(rec, "Term") ?? "", value: findAttr(rec, "String") ?? findAttr(rec, "Path") ?? findAttr(rec, "Bool") });
    }
    if (terms.length) annotations.push({ target, qualifier, terms });
  }

  return { version, namespaces: [...namespaces], entityTypes, entitySets, annotations };
}

export function findEntityType(model: EdmxModel, name: string) {
  const short = name.split("/").pop()!.split(".").pop()!;
  return model.entityTypes.find((t) => t.name === short);
}
