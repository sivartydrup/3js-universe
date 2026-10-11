/**
 * Timing constants shared by the director (which drives the fade envelope) and
 * the world generators (which need to know when the camera reaches a waypoint).
 */

/** Seconds spent fading a new world in. */
export const FADE_IN = 4.2;
/** Seconds spent fading a world out before it is replaced. */
export const FADE_OUT = 3.6;

/** Total lifetime of a world in seconds. */
export function worldLifetime(duration) {
  return FADE_IN + duration + FADE_OUT;
}

/**
 * The camera keeps drifting slightly into the black, so the path spans almost
 * the whole lifetime. Mirrors the director's mapping — keep in sync.
 */
export function pathSpan(duration) {
  return worldLifetime(duration) - FADE_OUT * 0.12;
}

/**
 * Seconds to fly a path of `length` at a steady `speed` units/second.
 *
 * Clamping the *speed* rather than the duration keeps the pacing of every
 * world alike: a sprawling system is given more time instead of being rushed,
 * and turn rate (≈ speed / radius) stays in the same gentle band everywhere.
 */
export function durationFor(length, { speed = 30, min = 26, max = 54 } = {}) {
  return Math.max(min, Math.min(max, length / speed));
}

/** Smoothstep-5 easing applied to path progress. */
export function pathEase(p) {
  const t = p < 0 ? 0 : p > 1 ? 1 : p;
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/**
 * Mid-path dwell. `dwell = 0` is uniform; positive values slow the middle of
 * the flight and speed up the ends, so the camera lingers through the pivot
 * (where the path bends most) instead of whipping around it.
 *
 * The derivative is `1 + dwell * cos(2πp)`: at the midpoint `1 - dwell`.
 */
export function dwellWarp(p, dwell) {
  if (!dwell) return p;
  const t = p < 0 ? 0 : p > 1 ? 1 : p;
  return t + (dwell / (2 * Math.PI)) * Math.sin(2 * Math.PI * t);
}

/** Fraction of path progress used by the director's eased curve. */
export function easedProgress(p, dwell = 0) {
  const q = dwellWarp(p, dwell);
  return q * 0.55 + pathEase(q) * 0.45;
}
