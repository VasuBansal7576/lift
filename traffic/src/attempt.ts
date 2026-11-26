import type { BarrierId } from "../../shared/types.ts";

export interface AttemptResult {
  converted: boolean;
  blockedBy: BarrierId[];
  reason: string;
}
