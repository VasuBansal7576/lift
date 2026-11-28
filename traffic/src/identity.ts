export function identityFor(runId: string, seed: number, index: number): string {
  return `lift-sim-${runId}-${seed}-${String(index).padStart(4, "0")}`;
}
