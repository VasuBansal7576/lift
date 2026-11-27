import { assertNever } from "./types.ts";

export const PATCH_SPEC_VERSION = 0 as const;

export const PATCH_OPS = [
  "setAttribute",
  "setText",
  "injectCSS",
  "wrapLabel",
  "makeFocusable",
  "bindEnterToClick",
  "replaceTag",
  "insertHTML",
] as const;

export type PatchOpName = (typeof PATCH_OPS)[number];

export const AXE_GATE_RULES = ["label", "button-name", "color-contrast"] as const;
export type AxeGateRule = (typeof AXE_GATE_RULES)[number];

export const INSERT_HTML_POSITIONS = ["before", "after", "prepend", "append"] as const;
export type InsertHtmlPosition = (typeof INSERT_HTML_POSITIONS)[number];

export const ALLOWED_REPLACE_TAGS = ["button", "label", "span", "a", "p", "strong", "em"] as const;
export type AllowedReplaceTag = (typeof ALLOWED_REPLACE_TAGS)[number];

const ALLOWED_ATTR_NAMES = new Set([
  "id",
  "class",
  "for",
  "type",
  "tabindex",
  "role",
  "alt",
  "lang",
  "autocomplete",
  "name",
  "title",
  "aria-expanded",
  "aria-controls",
  "aria-label",
  "aria-labelledby",
  "aria-describedby",
  "aria-hidden",
  "href",
]);

export interface SetAttributeOp {
  op: "setAttribute";
  selector: string;
  name: string;
  value: string;
}

export interface SetTextOp {
  op: "setText";
  selector: string;
  text: string;
}

export interface InjectCssOp {
  op: "injectCSS";
  css: string;
  id?: string;
}

export interface WrapLabelOp {
  op: "wrapLabel";
  selector: string;
  text: string;
}

export interface MakeFocusableOp {
  op: "makeFocusable";
  selector: string;
}

export interface BindEnterToClickOp {
  op: "bindEnterToClick";
  selector: string;
}

export interface ReplaceTagOp {
  op: "replaceTag";
  selector: string;
  tag: AllowedReplaceTag;
  attributes?: Record<string, string>;
}

export interface InsertHtmlOp {
  op: "insertHTML";
  selector: string;
  position: InsertHtmlPosition;
  html: string;
  mountId?: string;
}

export type PatchOp =
  | SetAttributeOp
  | SetTextOp
  | InjectCssOp
  | WrapLabelOp
  | MakeFocusableOp
  | BindEnterToClickOp
  | ReplaceTagOp
  | InsertHtmlOp;

export interface PatchSpec {
  id: string;
  version: typeof PATCH_SPEC_VERSION;
  ops: PatchOp[];
}

export type ParsePatchSpecResult =
  | { ok: true; spec: PatchSpec }
  | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function isAllowedAttributeName(name: string): boolean {
  if (name.toLowerCase().startsWith("on")) return false;
  if (ALLOWED_ATTR_NAMES.has(name)) return true;
  if (/^aria-[a-z0-9-]+$/.test(name)) return true;
  if (/^data-lift-[a-z0-9-]+$/.test(name)) return true;
  return false;
}

export function isSafeAttributeValue(name: string, value: string): boolean {
  if (/[\u0000-\u001F\u007F]/.test(value)) return false;
  if (/^\s*javascript:/i.test(value)) return false;
  if (name === "href") return value.startsWith("#") || value.startsWith("/");
  return true;
}

export function isSafeInsertHtml(html: string): boolean {
  if (/<\s*(script|iframe|object|embed|link|meta|style|form)\b/i.test(html)) return false;
  if (/\bon[a-z]+\s*=/i.test(html)) return false;
  if (/javascript:/i.test(html)) return false;
  return true;
}

function parseAttributes(raw: unknown): Record<string, string> | { error: string } {
  if (raw === undefined) return {};
  if (!isRecord(raw)) return { error: "attributes must be an object" };
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (!isAllowedAttributeName(name)) return { error: `disallowed attribute: ${name}` };
    if (typeof value !== "string") return { error: `attribute ${name} must be a string` };
    if (!isSafeAttributeValue(name, value)) return { error: `unsafe attribute value: ${name}` };
    out[name] = value;
  }
  return out;
}

function parseOp(raw: unknown, index: number): PatchOp | { error: string } {
  if (!isRecord(raw)) return { error: `ops[${index}] must be an object` };
  const op = raw.op;
  if (typeof op !== "string") return { error: `ops[${index}] missing op` };
  if (!(PATCH_OPS as readonly string[]).includes(op)) {
    return { error: `ops[${index}] unknown op: ${op}` };
  }
  const name = op as PatchOpName;
  switch (name) {
    case "setAttribute": {
      if (!isNonEmptyString(raw.selector)) return { error: `ops[${index}] selector required` };
      if (!isNonEmptyString(raw.name)) return { error: `ops[${index}] name required` };
      if (typeof raw.value !== "string") return { error: `ops[${index}] value must be a string` };
      if (!isAllowedAttributeName(raw.name)) return { error: `ops[${index}] disallowed attribute` };
      if (!isSafeAttributeValue(raw.name, raw.value)) {
        return { error: `ops[${index}] unsafe attribute value` };
      }
      return { op: "setAttribute", selector: raw.selector, name: raw.name, value: raw.value };
    }
    case "setText": {
      if (!isNonEmptyString(raw.selector)) return { error: `ops[${index}] selector required` };
      if (typeof raw.text !== "string") return { error: `ops[${index}] text must be a string` };
      return { op: "setText", selector: raw.selector, text: raw.text };
    }
    case "injectCSS": {
      if (!isNonEmptyString(raw.css)) return { error: `ops[${index}] css required` };
      if (/<\/\s*style/i.test(raw.css)) return { error: `ops[${index}] css must not close a style tag` };
      const id = raw.id;
      if (id !== undefined && !isNonEmptyString(id)) return { error: `ops[${index}] id must be a string` };
      return id === undefined
        ? { op: "injectCSS", css: raw.css }
        : { op: "injectCSS", css: raw.css, id };
    }
    case "wrapLabel": {
      if (!isNonEmptyString(raw.selector)) return { error: `ops[${index}] selector required` };
      if (!isNonEmptyString(raw.text)) return { error: `ops[${index}] text required` };
      return { op: "wrapLabel", selector: raw.selector, text: raw.text };
    }
    case "makeFocusable": {
      if (!isNonEmptyString(raw.selector)) return { error: `ops[${index}] selector required` };
      return { op: "makeFocusable", selector: raw.selector };
    }
    case "bindEnterToClick": {
      if (!isNonEmptyString(raw.selector)) return { error: `ops[${index}] selector required` };
      return { op: "bindEnterToClick", selector: raw.selector };
    }
    case "replaceTag": {
      if (!isNonEmptyString(raw.selector)) return { error: `ops[${index}] selector required` };
      if (typeof raw.tag !== "string" || !(ALLOWED_REPLACE_TAGS as readonly string[]).includes(raw.tag)) {
        return { error: `ops[${index}] tag is not allowlisted` };
      }
      const attributes = parseAttributes(raw.attributes);
      if ("error" in attributes) return { error: `ops[${index}] ${attributes.error}` };
      return {
        op: "replaceTag",
        selector: raw.selector,
        tag: raw.tag as AllowedReplaceTag,
        ...(Object.keys(attributes).length > 0 ? { attributes } : {}),
      };
    }
    case "insertHTML": {
      if (!isNonEmptyString(raw.selector)) return { error: `ops[${index}] selector required` };
      if (typeof raw.position !== "string" || !(INSERT_HTML_POSITIONS as readonly string[]).includes(raw.position)) {
        return { error: `ops[${index}] position must be before|after|prepend|append` };
      }
      if (typeof raw.html !== "string" || raw.html.length === 0) {
        return { error: `ops[${index}] html required` };
      }
      if (!isSafeInsertHtml(raw.html)) return { error: `ops[${index}] html is not allowlisted` };
      const mountId = raw.mountId;
      if (mountId !== undefined && !isNonEmptyString(mountId)) {
        return { error: `ops[${index}] mountId must be a string` };
      }
      return {
        op: "insertHTML",
        selector: raw.selector,
        position: raw.position as InsertHtmlPosition,
        html: raw.html,
        ...(mountId === undefined ? {} : { mountId }),
      };
    }
    default:
      return assertNever(name, "unhandled patch op");
  }
}

export function parsePatchSpec(input: unknown): ParsePatchSpecResult {
  if (!isRecord(input)) return { ok: false, error: "spec must be an object" };
  if (!isNonEmptyString(input.id)) return { ok: false, error: "id required" };
  if (input.version !== PATCH_SPEC_VERSION) {
    return { ok: false, error: `unsupported version: ${String(input.version)}` };
  }
  if (!Array.isArray(input.ops)) return { ok: false, error: "ops must be an array" };
  const ops: PatchOp[] = [];
  for (let i = 0; i < input.ops.length; i++) {
    const parsed = parseOp(input.ops[i], i);
    if ("error" in parsed) return { ok: false, error: parsed.error };
    ops.push(parsed);
  }
  return { ok: true, spec: { id: input.id, version: PATCH_SPEC_VERSION, ops } };
}
