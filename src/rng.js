/**
 * Deterministic, seedable randomness. Every generated world is reproducible
 * from a single 32-bit seed, which keeps long-running sessions consistent and
 * makes bugs reproducible.
 */

/** Fast 32-bit PRNG (mulberry32). Returns a function producing [0, 1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TAU = Math.PI * 2;

export class Rng {
  constructor(seed = (Math.random() * 0xffffffff) >>> 0) {
    this.seed = seed >>> 0;
    this._next = mulberry32(this.seed);
  }

  /** [0, 1) */
  next() {
    return this._next();
  }

  /** Uniform float in [min, max). */
  range(min, max) {
    return min + (max - min) * this._next();
  }

  /** Uniform integer in [min, max] inclusive. */
  int(min, max) {
    return min + Math.floor(this._next() * (max - min + 1));
  }

  /** True with probability p. */
  chance(p) {
    return this._next() < p;
  }

  /** Random element of an array. */
  pick(arr) {
    return arr[Math.floor(this._next() * arr.length) % arr.length];
  }

  /** Roughly normal distribution, mean 0, stddev 1 (sum of uniforms). */
  gauss() {
    return (this._next() + this._next() + this._next() - 1.5) * 1.4142;
  }

  /** Angle in [0, TAU). */
  angle() {
    return this._next() * TAU;
  }

  /** Sign, -1 or +1. */
  sign() {
    return this._next() < 0.5 ? -1 : 1;
  }

  /** A fresh Rng derived from this one — useful for per-subsystem streams. */
  fork() {
    return new Rng(Math.floor(this._next() * 0xffffffff) >>> 0);
  }
}

export { TAU };
