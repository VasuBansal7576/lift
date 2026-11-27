export const PATCH_SPEC_VERSION: 0;
export const PATCH_OPS: readonly string[];
export const INSERT_HTML_POSITIONS: readonly string[];
export const PROMOTE_AS: readonly string[];
export const PROMOTE_SOURCE_TAGS: Set<string>;
export const BLOCK_PROMOTE_CHILD_TAGS: Set<string>;
export const ALLOWED_REPLACE_TAGS: readonly string[];
export const REPLACE_SOURCE_TAGS: Set<string>;
export const WATCH_NODE_CAP: 2000;
export const GUARD_MAX_WAIT_MS: 250;
export const STRUCTURAL_ROLES: Set<string>;
export const MOUNT_ID_RE: RegExp;
export const INSERT_TAGS: Set<string>;
export const PATCH_OP_LIMIT: 50;
export const CSS_MATCH_LIMIT: 50;
export const FORBIDDEN_OP_HOSTS: Set<string>;
export const INTERACTIVE_ROLES: Set<string>;
export const LANDMARK_ROLES: Set<string>;

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
export function isNativeInteractiveHost(el: Element): boolean;
export function isFormControl(el: Element): boolean;
export function replaceTagHostAllowed(el: Element): boolean;
export function promoteHostAllowed(el: Element): boolean;
export function hasBlockPromoteChild(el: Element): boolean;
export function elementOrAncestorInteractive(el: Element): boolean;
export function roleAllowedOnElement(el: Element, value: string): boolean;
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
