import { CatmullRomCurve3, Vector3 } from 'three';

/** Position on a sphere shell: radius, azimuth, elevation → Vector3. */
export function spherical(r, azimuth, elevation, out = new Vector3()) {
  const ce = Math.cos(elevation);
  return out.set(ce * Math.cos(azimuth) * r, Math.sin(elevation) * r, ce * Math.sin(azimuth) * r);
}

/* ------------------------------------------------------------------ *
 * Monotone cubic interpolation (Fritsch–Carlson)                     *
 * ------------------------------------------------------------------ */

function pchipSlopes(xs, ys) {
  const n = xs.length;
  const h = new Array(n - 1);
  const d = new Array(n - 1);
  for (let i = 0; i < n - 1; i++) {
    h[i] = xs[i + 1] - xs[i];
    d[i] = (ys[i + 1] - ys[i]) / h[i];
  }
  const m = new Array(n);
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (d[i - 1] * d[i] <= 0) m[i] = 0;
    else {
      const w1 = 2 * h[i] + h[i - 1];
      const w2 = h[i] + 2 * h[i - 1];
      m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]);
    }
  }
  return m;
}

function pchipEval(xs, ys, ms, x) {
  const n = xs.length;
  if (x <= xs[0]) return ys[0];
  if (x >= xs[n - 1]) return ys[n - 1];
  let i = 0;
  while (i < n - 2 && x > xs[i + 1]) i++;
  const h = xs[i + 1] - xs[i];
  const t = (x - xs[i]) / h;
  const t2 = t * t;
  const t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1;
  const h10 = t3 - 2 * t2 + t;
  const h01 = -2 * t3 + 3 * t2;
  const h11 = t3 - t2;
  return h00 * ys[i] + h10 * h * ms[i] + h01 * ys[i + 1] + h11 * h * ms[i + 1];
}

/** Sort keyframes by f and force strictly increasing values (no NaN slopes). */
function monotonize(keys) {
  const sorted = keys
    .map((k) => ({ ...k, f: Math.max(0, Math.min(1, k.f)) }))
    .sort((a, b) => a.f - b.f);
  let prev = -Infinity;
  for (const k of sorted) {
    const f = Math.min(1, Math.max(k.f, prev + 0.012));
    k.f = f;
    prev = f;
  }
  // if the clamp pushed everything onto 1, walk the tail back down
  for (let i = sorted.length - 1; i > 0; i--) {
    if (sorted[i].f <= sorted[i - 1].f) sorted[i - 1].f = sorted[i].f - 0.012;
  }
  return sorted;
}

/** Build an interpolator over `keys` = [{ f, r }] (monotone in f, r > 0). */
function radiusProfile(keys) {
  if (keys.length === 1) {
    const only = Math.max(1e-3, keys[0].r);
    return () => only;
  }
  const ordered = monotonize(keys);
  const xs = ordered.map((k) => k.f);
  const ys = ordered.map((k) => Math.max(1e-3, k.r));
  const ms = pchipSlopes(xs, ys);
  return (f) => Math.max(1e-3, pchipEval(xs, ys, ms, f));
}

/** Elevation over the sweep, through the worlds being visited. */
function elevationProfile(keys, elFrom, elTo) {
  const all = [{ f: 0, el: elFrom }, ...(keys || []).filter((k) => k.f >= 0 && k.f <= 1), { f: 1, el: elTo }];
  if (all.length < 2) return () => elFrom;
  const ordered = monotonize(all);
  const xs = ordered.map((k) => k.f);
  const ys = ordered.map((k) => k.el);
  const ms = pchipSlopes(xs, ys);
  return (f) => pchipEval(xs, ys, ms, f);
}

/** Build component-wise interpolators for a list of { f, p } focus keys. */
function focusProfile(keys, fallback) {
  if (!keys || keys.length === 0) {
    return () => fallback.clone();
  }
  if (keys.length === 1) {
    const only = keys[0].p.clone();
    return () => only.clone();
  }
  const ordered = monotonize(keys);
  const xs = ordered.map((k) => k.f);
  const comp = [0, 1, 2].map((c) => {
    const ys = ordered.map((k) => k.p.getComponent(c));
    return { ys, ms: pchipSlopes(xs, ys) };
  });
  return (f) => new Vector3(
    pchipEval(xs, comp[0].ys, comp[0].ms, f),
    pchipEval(xs, comp[1].ys, comp[1].ms, f),
    pchipEval(xs, comp[2].ys, comp[2].ms, f)
  );
}

/**
 * Re-space a path evenly along its own arc length.
 *
 * The new waypoints lie *on* the original curve, so the shape (and therefore
 * the timing, which is arc-length based) is preserved — but no short segment
 * sits next to a long one any more. That matters because a Catmull-Rom spline
 * can curl where segment lengths jump, which is exactly the local lurch this
 * is meant to remove. The look-target curve is sampled at the same parameters.
 *
 * @param {Vector3[]} path
 * @param {Vector3[]} focus
 * @param {number} [density] waypoints per original waypoint
 * @returns {{path: Vector3[], focus: Vector3[]}}
 */
export function conditionPath(path, focus, density = 1.8) {
  if (path.length < 3) return { path, focus };
  const posCurve = new CatmullRomCurve3(path.map((p) => p.clone()), false, 'centripetal');
  const lookCurve = new CatmullRomCurve3(focus.map((p) => p.clone()), false, 'centripetal');
  const count = Math.max(8, Math.round(path.length * density));
  const outPath = [];
  const outFocus = [];
  for (let i = 0; i <= count; i++) {
    const u = i / count;
    const t = posCurve.getUtoTmapping(u);
    outPath.push(posCurve.getPoint(t, new Vector3()));
    outFocus.push(lookCurve.getPoint(t, new Vector3()));
  }
  return { path: outPath, focus: outFocus };
}

/**
 * Push waypoints out of bodies they would otherwise clip.
 *
 * Path authoring works in polar terms and cannot always know exactly how close
 * a pass ends up, so this is the final geometric guarantee: no waypoint sits
 * inside a body's keep-out sphere. Obstacles are { center, radius }; `margin`
 * leaves slack for the spline that will be fitted through these points.
 *
 * @param {Vector3[]} path
 * @param {{center: Vector3, radius: number}[]} obstacles
 * @param {number} [margin]
 */
export function enforceClearance(path, obstacles, margin = 1.3) {
  const dir = new Vector3();
  for (const p of path) {
    for (const o of obstacles) {
      const need = o.radius * margin;
      dir.copy(p).sub(o.center);
      const d = dir.length();
      if (d >= need) continue;
      if (d < 1e-6) dir.set(0, 1, 0);
      else dir.multiplyScalar(1 / d);
      p.copy(o.center).addScaledVector(dir, need);
    }
  }
  return path;
}

/**
 * Sharpest turn along a polyline, as curvature (radians per unit length).
 *
 * Turn *rate* is `curvature × speed`, so this is the quantity to minimise when
 * shaping a flight path: it says how hard the camera has to change heading per
 * metre travelled, independent of how long the flight lasts.
 */
export function maxCurvature(path) {
  let worst = 0;
  const a = new Vector3();
  const b = new Vector3();
  for (let i = 1; i < path.length - 1; i++) {
    a.copy(path[i + 1]).sub(path[i]);
    b.copy(path[i]).sub(path[i - 1]);
    const la = a.length();
    const lb = b.length();
    if (la < 1e-6 || lb < 1e-6) continue;
    const ang = Math.acos(Math.max(-1, Math.min(1, a.dot(b) / (la * lb))));
    worst = Math.max(worst, ang / ((la + lb) * 0.5));
  }
  return worst;
}

/**
 * Curvature of the path *as flown*: the spline is sampled densely first, so
 * curvature hiding between control points (where a spline can curl) is counted
 * rather than averaged away.
 */
export function pathCurvature(path, samples = 320) {
  if (path.length < 3) return 0;
  const curve = new CatmullRomCurve3(path.map((p) => p.clone()), false, 'centripetal');
  const dense = [];
  for (let i = 0; i <= samples; i++) dense.push(curve.getPointAt(i / samples, new Vector3()));
  return maxCurvature(dense);
}

/**
 * A flight path expressed as a sweep in azimuth with a radius profile.
 *
 * Reversals used to be authored as a single waypoint ("fly in, turn, fly out"),
 * which forces the whole turn into one spline segment and reads as the camera
 * bouncing off an invisible wall. Here the turn lives in the *shape* of the
 * radius profile, sampled finely and interpolated monotonically, so the
 * curvature is spread evenly and the radius can never bulge past its keys.
 *
 * @param {object} o
 * @param {number} o.azFrom        starting azimuth (radians)
 * @param {number} o.azTo          ending azimuth (radians, can pass azFrom)
 * @param {{f:number,r:number}[]} o.keys  radius keyframes, f ∈ [0,1] along the sweep
 * @param {number} [o.samples]     waypoints produced
 * @param {number} [o.elFrom]      starting elevation
 * @param {number} [o.elTo]        ending elevation
 * @param {{f:number,el:number}[]} [o.elKeys] elevation keyframes, so the path can
 *   ride the orbital plane of a world it is about to pass instead of crossing
 *   far above or below it
 * @param {{f:number,p:Vector3}[]} [o.focusKeys] look-target keyframes
 * @param {Vector3} [o.focusDefault] look target when no keys are given
 * @returns {{path: Vector3[], focus: Vector3[]}}
 */
export function polarSweep({
  azFrom,
  azTo,
  keys,
  samples = 18,
  elFrom = 0,
  elTo = 0,
  elKeys = null,
  focusKeys = null,
  focusDefault = new Vector3()
}) {
  const radiusAt = radiusProfile(keys);
  const elevAt = elevationProfile(elKeys, elFrom, elTo);
  const lookAt = focusProfile(focusKeys, focusDefault);
  const path = [];
  const focus = [];
  for (let i = 0; i <= samples; i++) {
    const f = i / samples;
    const az = azFrom + (azTo - azFrom) * f;
    path.push(spherical(radiusAt(f), az, elevAt(f)));
    focus.push(lookAt(f));
  }
  return { path, focus };
}
