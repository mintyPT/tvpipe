/**
 * A small seeded random source: mulberry32 (Tommy Ettinger's 32-bit
 * generator), hand-rolled. Everything the generator and the simulation
 * draw comes from here, so a seed gives the same estate on every engine
 * (only 32-bit integer arithmetic; `float()` divides by 2^32 exactly).
 *
 *   const rng = new Rng(hashSeed("van-doren", 3));
 *   rng.int(3, 9); rng.pick(["a", "b"]); rng.chance(0.25);
 */

export class Rng {
  #a: number;

  constructor(seed: number) {
    this.#a = seed >>> 0;
  }

  /** The state, to save and restore with {@link Rng.restore}. */
  get state(): number {
    return this.#a;
  }

  static restore(state: number): Rng {
    return new Rng(state);
  }

  /** The next 32-bit unsigned integer. */
  next(): number {
    this.#a = (this.#a + 0x6d2b79f5) >>> 0;
    let t = this.#a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }

  /** A number in [0, 1). */
  float(): number {
    return this.next() / 4294967296;
  }

  /** An integer in [lo, hi], both included (lo when hi < lo). */
  int(lo: number, hi: number): number {
    if (hi <= lo) return lo;
    return lo + Math.floor(this.float() * (hi - lo + 1));
  }

  /** True with probability p. */
  chance(p: number): boolean {
    return this.float() < p;
  }

  /** One of xs (undefined for an empty list). */
  pick<T>(xs: readonly T[]): T | undefined {
    return xs.length === 0 ? undefined : xs[Math.floor(this.float() * xs.length)];
  }

  /** One of xs, weighted (undefined when no weight is positive). */
  weighted<T>(xs: readonly T[], weight: (x: T) => number): T | undefined {
    let total = 0;
    for (const x of xs) total += Math.max(0, weight(x));
    if (!(total > 0)) return undefined;
    let r = this.float() * total;
    for (const x of xs) {
      const w = Math.max(0, weight(x));
      if (r < w) return x;
      r -= w;
    }
    for (let i = xs.length - 1; i >= 0; i--) if (weight(xs[i]!) > 0) return xs[i];
    return undefined;
  }

  /** A shuffled copy (Fisher–Yates). */
  shuffle<T>(xs: readonly T[]): T[] {
    const a = [...xs];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(this.float() * (i + 1));
      [a[i], a[j]] = [a[j]!, a[i]!];
    }
    return a;
  }
}

/**
 * A 32-bit seed from numbers and strings: FNV-1a over the parts (strings
 * as UTF-16 code units, numbers as their 32-bit value, little-endian),
 * with a separator between parts.
 */
export function hashSeed(...parts: readonly (number | string)[]): number {
  let h = 0x811c9dc5;
  const byte = (b: number) => {
    h ^= b & 0xff;
    h = Math.imul(h, 0x01000193) >>> 0;
  };
  parts.forEach((p, k) => {
    if (k > 0) byte(0x1f);
    if (typeof p === "string") {
      for (let i = 0; i < p.length; i++) {
        const c = p.charCodeAt(i);
        byte(c);
        if (c > 0xff) byte(c >>> 8);
      }
    } else {
      const n = p >>> 0;
      byte(n);
      byte(n >>> 8);
      byte(n >>> 16);
      byte(n >>> 24);
    }
  });
  return h >>> 0;
}
