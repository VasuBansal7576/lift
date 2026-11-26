import {
  DEFAULT_PERSONA_MIX,
  PERSONAS,
  type Persona,
  type PersonaMix,
} from "./types.ts";

export { DEFAULT_PERSONA_MIX };

export function parsePersonaMix(raw: string, fallback = DEFAULT_PERSONA_MIX): PersonaMix {
  if (!raw.trim()) return { ...fallback };
  const mix: PersonaMix = { mouse: 0, keyboard: 0, "screen-reader": 0, "low-vision": 0 };
  for (const part of raw.split(",")) {
    const [name, weight] = part.split(":").map((s) => s.trim());
    if (!name) continue;
    if (!(PERSONAS as readonly string[]).includes(name)) {
      throw new Error(`Unknown persona in LIFT_PERSONA_MIX: ${name}`);
    }
    const n = Number(weight);
    if (!Number.isFinite(n) || n < 0) {
      throw new Error(`Invalid weight for ${name} in LIFT_PERSONA_MIX`);
    }
    mix[name as Persona] = n;
  }
  const total = PERSONAS.reduce((sum, p) => sum + mix[p], 0);
  if (total <= 0) throw new Error("LIFT_PERSONA_MIX weights must sum to > 0");
  for (const p of PERSONAS) mix[p] /= total;
  return mix;
}

export function pickPersona(rand: () => number, mix: PersonaMix): Persona {
  let r = rand();
  for (const persona of PERSONAS) {
    r -= mix[persona];
    if (r <= 0) return persona;
  }
  return PERSONAS[PERSONAS.length - 1];
}

export function mixLabel(mix: PersonaMix): string {
  return PERSONAS.map((p) => `${p} ${(mix[p] * 100).toFixed(0)}%`).join(", ");
}

export function compactMix(mix: PersonaMix): string {
  return PERSONAS.map((p) => Math.round(mix[p] * 100)).join("/");
}

export function realisedMix(personas: Persona[]): PersonaMix {
  const mix: PersonaMix = { mouse: 0, keyboard: 0, "screen-reader": 0, "low-vision": 0 };
  if (personas.length === 0) return mix;
  for (const persona of personas) mix[persona] += 1;
  for (const p of PERSONAS) mix[p] /= personas.length;
  return mix;
}
