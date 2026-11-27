import { Window } from "happy-dom";
import {
  isAllowedAttributeName as rulesAllowedAttr,
  isSafeAttributeValue as rulesSafeAttrValue,
  isSafeHref as rulesSafeHref,
  isSafeInsertHtml as rulesSafeInsertHtml,
  isSafeMountId as rulesSafeMountId,
  parsePatchSpec as parsePatchSpecShared,
} from "../runtime/patch-rules.js";

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
  "toggleDisclosure",
] as const;

export type PatchOpName = (typeof PATCH_OPS)[number];

export const AXE_GATE_RULES = ["label", "button-name", "color-contrast"] as const;
export type AxeGateRule = (typeof AXE_GATE_RULES)[number];

export const INSERT_HTML_POSITIONS = ["before", "after", "prepend", "append"] as const;
export type InsertHtmlPosition = (typeof INSERT_HTML_POSITIONS)[number];

export const ALLOWED_REPLACE_TAGS = ["button", "label", "span", "a", "p", "strong", "em"] as const;
export type AllowedReplaceTag = (typeof ALLOWED_REPLACE_TAGS)[number];

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

export const CSS_STATES = [
  "focus",
  "focus-visible",
  "focus-within",
  "hover",
  "active",
  "disabled",
  "checked",
] as const;
export type CssState = (typeof CSS_STATES)[number];

export const CSS_PROPERTIES = [
  "color",
  "background-color",
  "outline-style",
  "outline-color",
  "outline-width",
  "outline-offset",
  "border-color",
  "border-width",
  "border-style",
  "font-size",
  "font-weight",
  "line-height",
  "letter-spacing",
  "word-spacing",
  "text-decoration-line",
  "text-decoration-thickness",
  "min-height",
  "min-width",
  "padding",
  "cursor",
] as const;
export type CssProperty = (typeof CSS_PROPERTIES)[number];

export interface CssSelector {
  tag?: string;
  classes?: string[];
  id?: string;
  state?: CssState;
}

export interface CssDeclaration {
  property: CssProperty;
  value: string | number;
}

export interface CssRule {
  selector: CssSelector;
  declarations: CssDeclaration[];
}

export interface InjectCssOp {
  op: "injectCSS";
  rules: CssRule[];
  css?: string;
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

export interface ToggleDisclosureOp {
  op: "toggleDisclosure";
  trigger: string;
  panel: string;
}

export type PatchOp =
  | SetAttributeOp
  | SetTextOp
  | InjectCssOp
  | WrapLabelOp
  | MakeFocusableOp
  | BindEnterToClickOp
  | ReplaceTagOp
  | InsertHtmlOp
  | ToggleDisclosureOp;

export interface PatchSpec {
  id: string;
  version: typeof PATCH_SPEC_VERSION;
  ops: PatchOp[];
}

export type ParsePatchSpecResult =
  | { ok: true; spec: PatchSpec }
  | { ok: false; error: string };

const nodeDoc: Document | undefined =
  typeof document === "undefined" ? (new Window().document as unknown as Document) : undefined;

export function isAllowedAttributeName(name: string): boolean {
  return rulesAllowedAttr(name);
}

export function isSafeHref(value: string): boolean {
  return rulesSafeHref(value);
}

export function isSafeAttributeValue(name: string, value: string): boolean {
  return rulesSafeAttrValue(name, value);
}

export function isSafeMountId(value: string): boolean {
  return rulesSafeMountId(value);
}

export function isSafeInsertHtml(html: string): boolean {
  return rulesSafeInsertHtml(html, nodeDoc);
}

export function parsePatchSpec(input: unknown): ParsePatchSpecResult {
  return parsePatchSpecShared(input, nodeDoc) as ParsePatchSpecResult;
}
