import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { AppConfig } from "../config.js";
import { logger } from "../logger.js";
import { assertUrlAllowed } from "../net/guard.js";

/**
 * UI5 API reference via the official TypeScript type definitions
 * (@openui5/ts-types-esm on jsDelivr/unpkg). Each library ships one big
 * .d.ts per namespace (e.g. types/sap.m.d.ts) including full JSDoc.
 * We fetch, cache and extract the requested symbol's module block.
 */

const DEFAULT_CDN = "https://cdn.jsdelivr.net/npm/@openui5/ts-types-esm";

export function libraryOf(controlName: string): string | null {
  const parts = controlName.split(".");
  if (parts.length < 3) return null; // e.g. sap.m.Table → sap.m = library
  return parts.slice(0, 2).join(".");
}

function cacheDir(config: AppConfig): string {
  return path.join(config.dataDir, "cache", "ui5-types");
}

async function fetchLibraryTypes(config: AppConfig, library: string, version: string): Promise<string> {
  const dir = cacheDir(config);
  const file = path.join(dir, `${version.replace(/\./g, "_")}_${library.replace(/\./g, "")}.d.ts`);
  if (fs.existsSync(file)) return fs.readFileSync(file, "utf8");
  const url = `${config.ui5TypesCdnUrl || DEFAULT_CDN}@${version}/types/${library}.d.ts`;
  assertUrlAllowed(config, url, [DEFAULT_CDN]);
  const res = await fetch(url, { signal: AbortSignal.timeout(config.requestTimeoutMs) });
  if (!res.ok) {
    throw new Error(`Type definitions for library '${library}' version '${version}' not available (HTTP ${res.status}). Check the control name, e.g. 'sap.m.Table'.`);
  }
  const content = await res.text();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, content, "utf8");
  logger.debug("ui5 types cached", { library, version, size: content.length });
  return content;
}

/** Extract the `declare module "<name>" { ... }` block for the control. */
export function extractModuleBlock(dts: string, controlName: string): string | null {
  // matches: declare module "sap/m/Table" {  (escaped or plain)
  const patterns = [`"${controlName}"`, `"${controlName.replace(/\./g, "/")}"`];
  for (const p of patterns) {
    const idx = dts.indexOf(`declare module ${p}`);
    if (idx === -1) continue;
    const openBrace = dts.indexOf("{", idx);
    if (openBrace === -1) continue;
    let depth = 0;
    let end = openBrace;
    for (let i = openBrace; i < dts.length; i++) {
      if (dts[i] === "{") depth++;
      else if (dts[i] === "}") {
        depth--;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
    return dts.slice(idx, end);
  }
  return null;
}

export async function getApiReference(config: AppConfig, controlName: string, ui5Version?: string): Promise<{ control: string; version: string; reference: string; truncated: boolean }> {
  const name = controlName.trim().replace(/\//g, ".");
  const library = libraryOf(name);
  if (!library) {
    throw new Error(`'${controlName}' is not a valid control name. Use the full namespace, e.g. 'sap.m.Table' or 'sap.ui.layout.form.SimpleForm'.`);
  }
  const version = ui5Version?.trim() || "1.120.0"; // released LTS is a safe default
  const dts = await fetchLibraryTypes(config, library, version);
  let block = extractModuleBlock(dts, name);
  if (!block) {
    throw new Error(`Symbol '${name}' was not found in ${library} type definitions (version ${version}).`);
  }
  let truncated = false;
  const MAX = 60000;
  if (block.length > MAX) {
    block = block.slice(0, MAX) + "\n\n/* …truncated… */";
    truncated = true;
  }
  return { control: name, version, reference: block, truncated };
}

/** Curated fallback info for the most common controls (works offline). */
export const CURATED_CONTROLS: Record<string, string> = {
  "sap.m.Table": "sap.m.Table: responsive table. Aggregations: headerToolbar, columns (Column), items (ColumnListItem). Properties: growing, growingThreshold, inset, fixedLayout, showOverlay. Events: updateFinished, updateStarted, itemPress (on items). Use with sap.m.Column + ColumnListItem cells.",
  "sap.m.List": "sap.m.List: list with items (StandardListItem, InputListItem, CustomListItem, ObjectListItem). Properties: mode (None/SingleSelectMaster/Delete/MultiSelect), growing, inset, headerText, showSeparators, swipeDirection. Events: itemPress, delete, selectionChange, swipe.",
  "sap.m.Input": "sap.m.Input: single-line input with suggestion support. Aggregations: suggestionItems (SuggestionItem), filters. Properties: value, placeholder, editable, enabled, showValueHelp, valueState (None/Error/Warning/Success/Information), valueStateText, textFormatMode, type (Text/Number/Email...). Events: change, liveChange, submit, valueHelpRequest, suggestionItemSelected.",
  "sap.m.Button": "sap.m.Button: press button. Properties: text, type (Default/Emphasized/Ghost/Back/Up/Reject/Accept/Transparent), icon, enabled, width, textDirection, ariaHasPopup, iconFirst. Event: press. Prefer type Emphasized for primary actions, one per page/dialog.",
  "sap.m.Dialog": "sap.m.Dialog: modal dialog. Aggregations: content, beginButton, endButton, subHeader. Properties: title, type (Standard/Message/Alert), contentWidth/Height, draggable, resizable, stretch, showHeader, escapeHandler. Events: beforeOpen, afterOpen, beforeClose, afterClose. Open with .open(), close with .close().",
  "sap.m.ComboBox": "sap.m.ComboBox: dropdown select with editable filter. Aggregation: items (ComboBoxItem {key,text}). Properties: selectedKey, selectedItemId, value, allowCustomValue, showSecondaryValues, filterSecondaryValues. Event: selectionChange, change.",
  "sap.m.UploadSet": "sap.m.UploadSet: file upload collection. Aggregations: items (UploadSetItem). Methods: upload(), addIncompleteItem(). Properties: uploadEnabled, maxFileNameLength, maxFileSize, multiple, uploadUrl, instantUpload, terminationEnabled, fileType (array of extensions). Events: uploadCompleted, filenameLengthExceed, fileRenamed, itemPressed. Configure the upload endpoint via uploadUrl; handle files with the uploadSetItemheaderpress flows.",
  "sap.f.FlexibleColumnLayout": "sap.f.FlexibleColumnLayout: up to 3-column responsive layout for FCL apps. Properties: layout (OneColumn/TwoColumnsBeginExpanded/TwoColumnsMidExpanded/ThreeColumnsMidExpanded/ThreeColumnsEndExpanded/ThreeColumnsEndCollapsed/TwoColumnsBeginExpandedEndHidden), backgroundDesign. Aggregations: beginColumnPages, midColumnPages, endColumnPages. Event: layoutChange. Pair with sap.f.routing.Router and layouts mapping in manifest.json.",
  "sap.ui.layout.form.SimpleForm": "sap.ui.layout.form.SimpleForm: lightweight form. Properties: editable, layout (ResponsiveGridLayout/ColumnLayout), labelSpanL/M/S, columnsL/M, minWidth. Content: alternate Label + control children (core:Title / Toolbar allowed as group breaks). For editable forms set editable=\"true\" and use sap.m.Input/ComboBox/Select etc."
};
