import {
  AdditiveBlending,
  CatmullRomCurve3,
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  Group,
  Points,
  Sprite,
  SpriteMaterial,
  Vector3
} from 'three';
import { TAU } from './rng.js';
import { durationFor } from './timing.js';
import { createPointsMaterial, setPointAttributes } from './points.js';
import { spherical, polarSweep, pathCurvature, conditionPath } from './paths.js';
import { sprites } from './textures.js';

const TYPES = ['spiral', 'spiral', 'spiral', 'barred', 'barred', 'pinwheel', 'ring', 'elliptical', 'irregular'];

const TYPE_NAME = {
  spiral: 'Spiral Galaxy',
  barred: 'Barred Spiral Galaxy',
  pinwheel: 'Grand-Design Pinwheel',
  ring: 'Ring Galaxy',
  elliptical: 'Elliptical Galaxy',
  irregular: 'Irregular Galaxy'
};

const CATALOGS = ['NGC', 'IC', 'UGC', 'PGC', 'ESO', 'MCG', 'ARP', 'VV'];

/** Hue-assisted colour helper: returns a Color in linear working space. */
function hslColor(h, s, l) {
  return new Color().setHSL(((h % 1) + 1) % 1, s, l);
}

/**
 * A galaxy: tens of thousands of additive dust motes arranged into arms,
 * a bright nucleus, in-disc nebulae and a graceful approach/exit path.
 */
export function createGalaxy(rng, seed) {
  const type = rng.pick(TYPES);
  const R = rng.range(210, 320);
  const group = new Group();
  const tex = sprites();

  /* ---- style -------------------------------------------------------- */
  const exotic = rng.chance(0.18);
  const coreHue = exotic ? rng.pick([0.55, 0.72, 0.86, 0.02]) : rng.range(0.06, 0.13);
  const armHue = exotic
    ? coreHue + rng.pick([0.35, 0.5, -0.3])
    : rng.chance(0.72)
      ? rng.range(0.53, 0.63)
      : rng.range(0.82, 0.95);
  const coreCol = hslColor(coreHue, rng.range(0.55, 0.9), rng.range(0.6, 0.8));
  const armCol = hslColor(armHue, rng.range(0.8, 1.0), rng.range(0.45, 0.62));
  const hotCol = hslColor(armHue - 0.02, rng.range(0.55, 0.9), 0.88);
  const hazeCol = hslColor(rng.pick([0.92, 0.62, 0.78, 0.42, 0.03]), rng.range(0.85, 1.0), 0.52);

  /* ---- geometry parameters ------------------------------------------ */
  const arms = type === 'irregular' || type === 'elliptical' ? 0 : rng.int(2, type === 'spiral' ? 6 : 4);
  const twistRad = rng.range(1.9, 4.6);
  const armSpread = rng.range(0.07, 0.17);
  const discScale = R * rng.range(0.2, 0.32);
  const thickness = R * rng.range(0.015, 0.05);
  const bulgeFrac = type === 'elliptical' ? 1 : type === 'ring' ? 0.1 : rng.range(0.08, 0.2);
  const ringR = R * rng.range(0.6, 0.78);
  const ringW = R * rng.range(0.05, 0.13);
  const barLen = R * rng.range(0.26, 0.45);
  const clumps = [];
  for (let i = 0; i < rng.int(5, 11); i++) clumps.push(spherical(R * rng.range(0.15, 0.95), rng.angle(), rng.range(-0.25, 0.25)));

  /* ---- particles ---------------------------------------------------- */
  const count = Math.round(rng.range(60000, 92000));
  const positions = new Float32Array(count * 3);
  const colors = [];
  const sizes = [];
  const alphas = [];
  const c = new Color();

  for (let i = 0; i < count; i++) {
    let x = 0;
    let y = 0;
    let z = 0;
    let rNorm = 0;
    let isBulge = false;

    if (type === 'elliptical') {
      const s = R * rng.range(0.3, 0.5);
      const rr = Math.pow(rng.next(), 0.42);
      const az = rng.angle();
      const el = Math.asin(rng.range(-1, 1));
      x = Math.cos(el) * Math.cos(az) * rr * s;
      y = Math.sin(el) * rr * s * 0.72;
      z = Math.cos(el) * Math.sin(az) * rr * s;
      rNorm = rr;
    } else if (rng.next() < bulgeFrac) {
      isBulge = true;
      const s = R * rng.range(0.07, 0.14);
      x = rng.gauss() * s;
      y = rng.gauss() * s * 0.68;
      z = rng.gauss() * s;
      rNorm = Math.min(1, Math.hypot(x, y, z) / R);
    } else if (type === 'ring') {
      const theta = rng.angle();
      const r = Math.max(R * 0.02, ringR + rng.gauss() * ringW);
      x = Math.cos(theta) * r + rng.gauss() * R * 0.012;
      z = Math.sin(theta) * r + rng.gauss() * R * 0.012;
      y = rng.gauss() * thickness * 0.8;
      rNorm = Math.min(1, r / R);
    } else if (type === 'irregular') {
      const cl = rng.pick(clumps);
      const s = R * rng.range(0.08, 0.22);
      x = cl.x + rng.gauss() * s;
      y = cl.y + rng.gauss() * s * 0.7;
      z = cl.z + rng.gauss() * s;
      rNorm = Math.min(1, Math.hypot(x, y, z) / R);
    } else {
      // exponential disc, optionally wrapped around a central bar
      let r = -discScale * Math.log(1 - rng.next() * 0.995);
      r = Math.min(r, R * 1.12);
      const useBar = type === 'barred' && r < barLen && rng.chance(0.55);
      if (useBar) {
        const t = (rng.next() * 2 - 1) * barLen;
        const taper = 1 - Math.abs(t) / barLen;
        x = t;
        z = rng.gauss() * R * 0.03 * (0.25 + taper);
        y = rng.gauss() * thickness * 0.6 * taper;
        rNorm = Math.min(1, Math.abs(t) / R);
      } else {
        const swirl = (r / R) * twistRad;
        const armBase = (Math.floor(rng.next() * arms) / arms) * TAU;
        const theta = armBase + swirl + rng.gauss() * armSpread * (0.3 + 0.9 * (r / R));
        x = Math.cos(theta) * r;
        z = Math.sin(theta) * r;
        y = rng.gauss() * thickness * (0.55 + 0.7 * (r / R));
        rNorm = Math.min(1, r / R);
      }
    }

    positions[i * 3] = x;
    positions[i * 3 + 1] = y;
    positions[i * 3 + 2] = z;

    // colour: warm, dense nucleus fading into young blue/hot arm stars
    const t = isBulge ? 0 : Math.min(1, Math.pow(rNorm, 0.8));
    const hot = rng.chance(isBulge ? 0.03 : 0.05 + 0.12 * t);
    if (hot) c.copy(hotCol);
    else c.copy(coreCol).lerp(armCol, t);
    c.offsetHSL(rng.gauss() * 0.012, rng.gauss() * 0.05, rng.gauss() * 0.05);
    colors.push(c.r, c.g, c.b);

    const bright = hot && rng.chance(0.5);
    sizes.push(bright ? rng.range(1.0, 2.2) : 0.22 + Math.pow(rng.next(), 3) * 1.0);
    alphas.push(
      (isBulge ? rng.range(0.06, 0.19) : rng.range(0.1, 0.34)) * (bright ? 1.5 : 1)
    );
  }

  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(positions, 3));
  setPointAttributes(geo, colors, sizes, alphas);
  const mat = createPointsMaterial({ additive: true, maxSize: 16 });
  const dust = new Points(geo, mat);
  dust.frustumCulled = false;
  group.add(dust);

  /* ---- nucleus glow -------------------------------------------------- */
  let nucleus = null;
  {
    const halo = new Sprite(
      new SpriteMaterial({
        map: tex.halo,
        color: coreCol,
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
        opacity: rng.range(0.045, 0.085)
      })
    );
    halo.scale.setScalar(R * rng.range(0.25, 0.4));
    group.add(halo);

    const core = new Sprite(
      new SpriteMaterial({
        map: tex.core,
        color: new Color().copy(coreCol).lerp(new Color(1, 1, 1), 0.4),
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
        opacity: rng.range(0.2, 0.32)
      })
    );
    core.scale.setScalar(R * rng.range(0.035, 0.075));
    group.add(core);

    // the nucleus veil must recede as the observer closes in, otherwise the
    // close pass through the bulge turns into a featureless white smear
    nucleus = {
      halo,
      core,
      haloBase: halo.material.opacity,
      coreBase: core.material.opacity
    };
  }

  /* ---- nebulae in the disc ------------------------------------------ */
  {
    const n = rng.int(18, 34);
    const cloud = tex.clouds;
    for (let i = 0; i < n; i++) {
      const rr = Math.min(R * 1.05, -discScale * Math.log(1 - rng.next() * 0.96) + R * 0.1);
      const swirl = (rr / R) * twistRad;
      const armBase = arms ? (Math.floor(rng.next() * arms) / arms) * TAU : 0;
      const theta = arms
        ? armBase + swirl + rng.gauss() * armSpread * 0.9
        : rng.angle();
      const col = rng.chance(0.55)
        ? hazeCol
        : hslColor(armHue + rng.gauss() * 0.06, rng.range(0.5, 0.9), rng.range(0.5, 0.75));
      const s = new Sprite(
        new SpriteMaterial({
          map: rng.pick(cloud),
          color: col,
          transparent: true,
          depthWrite: false,
          blending: AdditiveBlending,
          opacity: rng.range(0.02, 0.06),
          rotation: rng.angle()
        })
      );
      const size = R * rng.range(0.1, 0.28);
      s.scale.set(size, size, 1);
      s.position.set(Math.cos(theta) * rr, rng.gauss() * thickness * 1.4, Math.sin(theta) * rr);
      group.add(s);
    }
  }

  group.rotation.y = rng.angle();

  /* ---- flight path: one long sweep in past the nucleus and out again ---- */
  const a0 = rng.angle();
  const tilt = rng.range(0.05, 0.3) * rng.sign();

  // Try a handful of profiles and fly the one with the softest curvature —
  // the quietest way through the nucleus for this particular galaxy.
  let sweep = null;
  let bestK = Infinity;
  for (let attempt = 0; attempt < 10; attempt++) {
    const swingF = rng.range(0.5, 0.68);
    const rMin = R * rng.range(0.46, 0.66);
    const candidate = polarSweep({
      azFrom: a0,
      azTo: a0 + rng.range(3.0, 3.8),
      keys: [
        { f: 0, r: R * rng.range(2.3, 2.75) },
        { f: swingF * 0.45, r: R * rng.range(1.0, 1.3) },
        { f: swingF, r: rMin },
        { f: swingF + rng.range(0.1, 0.2), r: rMin * rng.range(1.15, 1.45) },
        { f: 1, r: R * rng.range(2.3, 2.8) }
      ],
      samples: rng.int(18, 24),
      elFrom: tilt * rng.range(0.8, 1.15),
      elTo: -tilt * rng.range(0.8, 1.15),
      focusKeys: [
        { f: 0, p: new Vector3() },
        { f: swingF * 0.7, p: new Vector3(rng.gauss() * R * 0.03, rng.gauss() * R * 0.02, rng.gauss() * R * 0.03) },
        { f: swingF, p: new Vector3(rng.gauss() * R * 0.05, rng.gauss() * R * 0.04, rng.gauss() * R * 0.05) },
        { f: 1, p: new Vector3(rng.gauss() * R * 0.04, rng.gauss() * R * 0.03, rng.gauss() * R * 0.04) }
      ]
    });
    const k = pathCurvature(candidate.path);
    if (k < bestK) {
      bestK = k;
      sweep = candidate;
    }
  }

  const pathLength = new CatmullRomCurve3(sweep.path.map((p) => p.clone()), false, 'centripetal').getLength();
  const shaped = conditionPath(sweep.path, sweep.focus);

  const catalog = rng.pick(CATALOGS);
  const name = `${catalog} ${String(rng.int(100, 9999)).padStart(4, '0')} · ${TYPE_NAME[type]}`;

  return {
    kind: 'galaxy',
    group,
    name,
    seed,
    path: shaped.path,
    focus: shaped.focus,
    duration: durationFor(pathLength),
    // glide in and out a little quicker, linger through the pivot
    dwell: rng.range(0.32, 0.46),
    spin: rng.range(0.004, 0.012) * rng.sign(),
    update(dt, t, camera) {
      if (!camera || !nucleus) return;
      const k = Math.min(1, camera.position.length() / (R * 0.85));
      const f = 0.18 + 0.82 * k * k;
      nucleus.halo.material.opacity = nucleus.haloBase * f;
      nucleus.core.material.opacity = nucleus.coreBase * f;
    }
  };
}
