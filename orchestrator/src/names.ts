export const FLAG_PREFIX = "lift_orch_";
export const DESCRIPTION_MARKER = "Lift orchestrator gated accessibility variants";
export const SPEC_ID_RE = /^[a-z0-9-]{1,40}$/;
export const FLAG_NAME_RE = /^lift_orch_[a-z0-9_-]+$/;

export function isValidSpecId(id: string): boolean {
  return SPEC_ID_RE.test(id);
}

export function assertSpecId(id: string): void {
  if (!isValidSpecId(id)) {
    throw new Error(`Spec id ${id} must match ${SPEC_ID_RE}`);
  }
}

export function assertOrchFlagName(name: string): void {
  if (!name.startsWith(FLAG_PREFIX) || !FLAG_NAME_RE.test(name)) {
    throw new Error(`Flag name must match ${FLAG_NAME_RE.source}`);
  }
}

export function genFlagName(base: string, generation: number): string {
  assertOrchFlagName(base);
  return generation === 1 ? base : `${base}_g${generation}`;
}

export function isOrchDescription(description: string | null | undefined): boolean {
  return Boolean(description && description.includes(DESCRIPTION_MARKER));
}
