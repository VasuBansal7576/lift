import type { PatchSpec } from "../shared/patch-spec.ts";

export {
  isAllowedAttributeName,
  isSafeAttributeValue,
  isSafeHref,
  isSafeInsertHtml,
  isSafeMountId,
  parsePatchSpec,
} from "./patch-rules.js";

export function validatePatchSpec(
  input: unknown,
): { ok: true; spec: PatchSpec } | { ok: false; error: string };

export interface ApplyOpStatus {
  op: string;
  status: "applied" | "noop";
}

export function applyPatchSpec(
  input: unknown,
  root?: ParentNode | Document,
):
  | { ok: true; ops: ApplyOpStatus[] }
  | { ok: false; error: string; ops: ApplyOpStatus[] };

export function resetRuntimeGuards(): void;
export function setTestBackstopsPaused(paused: boolean): boolean;
export function getRuntimeStats(): {
  undos: number;
  attributions: number;
  ticksRan: number;
  ticksSkipped: number;
};
