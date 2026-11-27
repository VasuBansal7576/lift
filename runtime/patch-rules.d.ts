export const PATCH_SPEC_VERSION: 0;
export const PATCH_OPS: readonly string[];
export const INSERT_HTML_POSITIONS: readonly string[];
export const ALLOWED_REPLACE_TAGS: readonly string[];
export const MOUNT_ID_RE: RegExp;
export const INSERT_TAGS: Set<string>;
export const PATCH_OP_LIMIT: 50;
export const CSS_MATCH_LIMIT: 50;
export const FORBIDDEN_OP_HOSTS: Set<string>;

export function isSafeMountId(value: unknown): value is string;
export function isAllowedAttributeName(name: string): boolean;
export function isSafeHref(value: string): boolean;
export function isSafeAttributeValue(name: string, value: string): boolean;
export function selectorTargetsForbiddenHost(selector: string): boolean;
export function selectorTargetsForbiddenTextHost(selector: string): boolean;
export function localTagName(el: Element): string;
export function isHtmlNamespace(el: Element): boolean;
export function elementForbiddenAsTextOrTagHost(el: Element): boolean;
export function elementIsPageContainer(el: Element): boolean;
export function elementHasVoidOrControlDescendant(el: Element): boolean;
export function isLabelableTextControl(el: Element | null): boolean;
export function elementHasElementChildren(el: Element): boolean;
export function isInteractiveElement(el: Element): boolean;
export function elementHasInteractiveDescendant(el: Element): boolean;
export function attributeWouldHideInteractive(name: string, value: string, el: Element): boolean;
export function hashKey(value: string): string;
export function cssKey(op: { css: string; id?: string }): string;
export function mountKeyFor(op: {
  position: string;
  selector: string;
  html: string;
  mountId?: string;
}): string;
export function sanitizeInsertHtml(html: string, doc?: Document): DocumentFragment | null;
export function isSafeInsertHtml(html: string, doc?: Document): boolean;
export function parsePatchSpec(
  input: unknown,
  doc?: Document,
): { ok: true; spec: { id: string; version: 0; ops: object[] } } | { ok: false; error: string };
