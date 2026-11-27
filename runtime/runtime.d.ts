import type { PatchSpec } from "../shared/patch-spec.ts";

export function isAllowedAttributeName(name: string): boolean;
export function isSafeAttributeValue(name: string, value: string): boolean;
export function isSafeInsertHtml(html: string): boolean;

export function validatePatchSpec(
  input: unknown,
): { ok: true; spec: PatchSpec } | { ok: false; error: string };

export function applyPatchSpec(
  input: unknown,
  root?: ParentNode | Document,
): { ok: true } | { ok: false; error: string };
