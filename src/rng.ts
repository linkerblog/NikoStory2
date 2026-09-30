// Stateless RNG: it depends only on (seed, tick, key). That way replaying a game gives the same
// result without having to persist the generator state.
export function rngFor(seed: number, tick: number, key: string): () => number {
  let h = (2166136261 ^ seed) >>> 0;
  for (const c of `${tick}:${key}`) {
    h ^= c.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
