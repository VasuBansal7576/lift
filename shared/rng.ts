export function mulberry32(seed: number) {
  let t = seed >>> 0;
  return function next() {
    t += 0x6d2b79f5;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

export function pickIndex(rand: () => number, n: number) {
  return Math.floor(rand() * n);
}

/** FNV-1a mix of trafficSeed + run id + batch + stream so batches are independent. */
export function mixSeed(
  trafficSeed: number,
  runId: string,
  batch: number,
  stream: "persona" | "dropout",
): number {
  const s = `${trafficSeed >>> 0}:${runId}:${batch >>> 0}:${stream}`;
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
