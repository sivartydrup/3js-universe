import {
  AdditiveBlending,
  AmbientLight,
  BufferGeometry,
  CatmullRomCurve3,
  Color,
  DirectionalLight,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PointLight,
  Points,
  RingGeometry,
  ShaderMaterial,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  Vector3
} from 'three';
import { durationFor, easedProgress, pathSpan } from './timing.js';
import { createPointsMaterial, setPointAttributes } from './points.js';
import { spherical, polarSweep, pathCurvature, conditionPath, enforceClearance } from './paths.js';
import { planetSurface, radialRingUVs, ringTexture, sprites, starSurface } from './textures.js';

/** Stellar classes: colour, relative size, relative mass (for naming flavour). */
const CLASSES = [
  { cls: 'M', color: 0xff8a52, size: 0.62, weight: 0.34 },
  { cls: 'K', color: 0xffb469, size: 0.82, weight: 0.2 },
  { cls: 'G', color: 0xfff0c9, size: 1.0, weight: 0.2 },
  { cls: 'F', color: 0xfffcf2, size: 1.16, weight: 0.13 },
  { cls: 'A', color: 0xdfeaff, size: 1.42, weight: 0.08 },
  { cls: 'B', color: 0xb9d1ff, size: 1.95, weight: 0.04 },
  { cls: 'O', color: 0xa6c2ff, size: 2.8, weight: 0.01 }
];

const ATMOSPHERE_VERT = /* glsl */ `
  varying vec3 vNormal;
  varying vec3 vView;
  void main() {
    vNormal = normalize(normalMatrix * normal);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vView = -mv.xyz;
    gl_Position = projectionMatrix * mv;
  }
`;

const ATMOSPHERE_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uPower;
  uniform float uIntensity;
  varying vec3 vNormal;
  varying vec3 vView;
  void main() {
    float f = pow(1.0 - abs(dot(normalize(vNormal), normalize(vView))), uPower);
    gl_FragColor = vec4(uColor * f * uIntensity, f * uIntensity);
  }
`;

function pickClass(rng) {
  const total = CLASSES.reduce((s, c) => s + c.weight, 0);
  let x = rng.next() * total;
  for (const c of CLASSES) {
    x -= c.weight;
    if (x <= 0) return c;
  }
  return CLASSES[2];
}

const PLANET_KINDS = {
  inner: ['lava', 'desert', 'rocky', 'rocky'],
  mid: ['rocky', 'ocean', 'terran', 'desert'],
  outer: ['gas', 'gas', 'ice', 'ice']
};

/**
 * A planetary system: one star with corona, a handful of orbiting worlds with
 * rings, atmospheres and moons, plus a debris belt. The camera glides past the
 * worlds and out again.
 */
export function createStarSystem(rng, seed) {
  const group = new Group();
  const tex = sprites();
  const Updaters = [];

  /* ---- star --------------------------------------------------------- */
  const spec = pickClass(rng);
  const starR = rng.range(14, 30) * spec.size;
  const starColor = new Color(spec.color);
  const starHue = new Color().copy(starColor);
  const starGeo = new SphereGeometry(1, 48, 32);

  const star = new Mesh(
    starGeo,
    new MeshBasicMaterial({
      map: starSurface(rng.int(1, 0x7ffffff0)),
      color: new Color(starColor.r * 1.3 + 0.05, starColor.g * 1.22 + 0.05, starColor.b * 1.15 + 0.05)
    })
  );
  star.scale.setScalar(starR);
  star.rotation.z = rng.range(-0.6, 0.6);
  group.add(star);

  const coronae = [];
  {
    const layers = [
      { t: 'core', s: 2.0, o: 0.3 },
      { t: 'halo', s: 4.4, o: 0.14 },
      { t: 'halo', s: 9.5, o: 0.045 }
    ];
    for (const l of layers) {
      const s = new Sprite(
        new SpriteMaterial({
          map: tex[l.t],
          color: starColor,
          transparent: true,
          depthWrite: false,
          depthTest: false,
          blending: AdditiveBlending,
          opacity: l.o
        })
      );
      s.scale.setScalar(starR * l.s);
      s.position.set(0, 0, 0);
      s.renderOrder = 6;
      group.add(s);
      coronae.push({ sprite: s, base: starR * l.s, phase: rng.angle(), amp: rng.range(0.01, 0.035) });
    }
  }

  /* ---- lights ------------------------------------------------------- */
  const starLight = new PointLight(starColor, 34000, 0, 2);
  starLight.position.set(0, 0, 0);
  group.add(starLight);
  group.add(new AmbientLight(0x2a3550, 0.6));
  {
    const dir = new DirectionalLight(0x93b8ff, 0.55);
    dir.position.copy(spherical(1, rng.angle(), rng.range(-1, 1)));
    group.add(dir);
  }

  Updaters.push((dt, t) => {
    star.rotation.y += dt * 0.035;
    for (const c of coronae) {
      const k = 1 + Math.sin(t * 0.42 + c.phase) * c.amp;
      c.sprite.scale.setScalar(c.base * k);
    }
  });

  /* ---- planets ------------------------------------------------------ */
  const planetCount = rng.int(1, 5);
  const planets = [];
  let dist = starR * 2 + rng.range(45, 80);
  for (let i = 0; i < planetCount; i++) {
    const slot = i / Math.max(1, planetCount - 1);
    const zone = i === 0 && planetCount > 1 ? 'inner' : slot > 0.66 ? 'outer' : 'mid';
    const kind = rng.pick(PLANET_KINDS[zone]);

    let radius = rng.range(2.6, 5.6);
    if (kind === 'gas') radius = rng.range(8, 14);
    else if (kind === 'ice') radius = rng.range(4.5, 9);

    const { map, emissiveMap } = planetSurface(rng, kind);
    const mat = new MeshStandardMaterial({
      map,
      roughness: rng.range(0.6, 1.0),
      metalness: rng.range(0, 0.15)
    });
    if (emissiveMap) {
      mat.emissiveMap = emissiveMap;
      mat.emissive = new Color(1.0, 0.55, 0.25);
      mat.emissiveIntensity = rng.range(0.9, 1.8);
    }
    const body = new Mesh(starGeo, mat);
    body.scale.set(radius * rng.range(0.98, 1.02), radius * rng.range(0.94, 1.0), radius);

    const node = new Group();
    const tilt = new Group();
    tilt.rotation.z = rng.range(-0.5, 0.5);
    tilt.rotation.x = rng.range(-0.2, 0.2);
    tilt.add(body);

    // atmosphere rim
    if (kind !== 'lava' && rng.chance(0.65)) {
      const atmoCol = new Color().setHSL(rng.range(0.52, 0.66), rng.range(0.5, 0.9), 0.62);
      const shell = new Mesh(
        starGeo,
        new ShaderMaterial({
          uniforms: {
            uColor: { value: atmoCol },
            uPower: { value: rng.range(2.4, 4.2) },
            uIntensity: { value: rng.range(0.5, 1.1) }
          },
          vertexShader: ATMOSPHERE_VERT,
          fragmentShader: ATMOSPHERE_FRAG,
          transparent: true,
          depthWrite: false,
          blending: AdditiveBlending
        })
      );
      shell.scale.setScalar(radius * 1.05);
      shell.renderOrder = 1;
      tilt.add(shell);
    }

    // rings for larger worlds
    if (kind === 'gas' && rng.chance(0.7)) {
      const inner = 1.35;
      const outer = rng.range(2.0, 2.6);
      const rg = new RingGeometry(inner, outer, 128, 1);
      radialRingUVs(rg, inner, outer);
      const ring = new Mesh(
        rg,
        new MeshStandardMaterial({
          map: ringTexture(rng),
          transparent: true,
          side: DoubleSide,
          roughness: 0.95,
          metalness: 0.05,
          depthWrite: false
        })
      );
      ring.rotation.x = -Math.PI / 2;
      ring.scale.setScalar(radius);
      tilt.add(ring);
    }

    node.add(tilt);

    // moons
    const moons = [];
    const moonCount = kind === 'gas' || kind === 'ice' ? rng.int(1, 3) : rng.chance(0.35) ? 1 : 0;
    for (let m = 0; m < moonCount; m++) {
      const mp = new Group();
      mp.rotation.y = rng.angle();
      mp.rotation.z = rng.range(-0.3, 0.3);
      const mr = radius * rng.range(0.16, 0.3);
      const moon = new Mesh(
        starGeo,
        new MeshStandardMaterial({
          color: new Color().setHSL(rng.range(0.05, 0.12), rng.range(0.05, 0.2), rng.range(0.35, 0.65)),
          roughness: 1,
          metalness: 0
        })
      );
      moon.scale.setScalar(mr);
      moon.position.set(radius * rng.range(3.2, 7.5), 0, 0);
      mp.add(moon);
      node.add(mp);
      moons.push({ pivot: mp, speed: rng.range(0.05, 0.16) * rng.sign() });
    }

    // orbit assembly
    const orbitPlane = new Group();
    orbitPlane.rotation.x = rng.range(-0.12, 0.12);
    orbitPlane.rotation.z = rng.range(-0.12, 0.12);
    const pivot = new Group();
    pivot.rotation.y = rng.angle();
    node.position.set(dist, 0, 0);
    pivot.add(node);
    orbitPlane.add(pivot);
    group.add(orbitPlane);

    const speed = rng.range(0.012, 0.02) * Math.pow(70 / dist, 1.5) * rng.sign();
    const spin = rng.range(0.05, 0.35) * rng.sign();
    const rec = { kind, radius, dist, node, body, pivot, moons, speed, spin, world: new Vector3(), predicted: null };
    planets.push(rec);
    Updaters.push((dt) => {
      pivot.rotation.y += speed * dt;
      body.rotation.y += spin * dt;
      for (const m of moons) m.pivot.rotation.y += m.speed * dt;
      node.getWorldPosition(rec.world);
    });

    dist *= rng.range(1.45, 2.1);
    if (dist > 620) break;
  }

  /* ---- debris belt -------------------------------------------------- */
  if (planets.length >= 2 && rng.chance(0.75)) {
    const i = rng.int(0, planets.length - 2);
    const r1 = planets[i].dist + planets[i].radius * 1.6;
    const r2 = planets[i + 1] ? planets[i + 1].dist - planets[i + 1].radius * 2.2 : r1 * 1.5;
    const inner = r1;
    const outer = Math.max(r1 * 1.12, Math.min(r2, r1 * 1.8));
    const count = rng.int(4200, 9000);
    const positions = new Float32Array(count * 3);
    const colors = [];
    const sizes = [];
    const alphas = [];
    const c = new Color();
    const thick = (outer - inner) * 0.16;
    for (let k = 0; k < count; k++) {
      const r = rng.range(inner, outer);
      const theta = rng.angle();
      positions[k * 3] = Math.cos(theta) * r;
      positions[k * 3 + 1] = rng.gauss() * thick * 0.5;
      positions[k * 3 + 2] = Math.sin(theta) * r;
      c.setHSL(rng.range(0.05, 0.12), rng.range(0.05, 0.35), rng.range(0.25, 0.72));
      colors.push(c.r, c.g, c.b);
      sizes.push(rng.range(0.25, 1.1));
      alphas.push(1);
    }
    const bg = new BufferGeometry();
    bg.setAttribute('position', new Float32BufferAttribute(positions, 3));
    setPointAttributes(bg, colors, sizes, alphas);
    const bmat = createPointsMaterial({ opaque: true, maxSize: 22 });
    const belt = new Points(bg, bmat);
    belt.frustumCulled = false;
    const beltPivot = new Group();
    beltPivot.rotation.x = rng.range(-0.08, 0.08);
    beltPivot.add(belt);
    group.add(beltPivot);
    const beltSpin = rng.range(0.004, 0.014) * rng.sign();
    Updaters.push((dt) => {
      beltPivot.rotation.y += beltSpin * dt;
    });
  }

  /* ---- flight path --------------------------------------------------- */
  // One long sweep around the system: drift in, graze the worlds being
  // visited, pivot past the star, then leave on the far side. Expressed as a
  // radius profile over azimuth (see polarSweep) so the camera's direction
  // changes live in the *shape* of the curve rather than being crammed into a
  // single waypoint — which is what used to feel like bouncing off the star.
  const dwell = rng.range(0.24, 0.4);
  const outerDist = planets.length ? planets[planets.length - 1].dist : starR * 6;

  const probe = new Vector3();
  const azOf = (v) => {
    v.node.getWorldPosition(probe);
    return Math.atan2(probe.z, probe.x);
  };

  // Candidate visit plans: which worlds to graze, and which way round the
  // system to sweep. Each is scored by the sharpest curvature it produces, so
  // the camera takes the quietest route this particular layout allows — with
  // the radius profile running in one direction past the star instead of
  // zig-zagging between worlds.
  const interesting = planets.filter((p) => p.kind !== 'ice');
  const pool = (interesting.length ? interesting : planets).slice();
  const cruise = outerDist * rng.range(1.2, 1.45);
  const passR = Math.max(starR * rng.range(4.5, 6), cruise * rng.range(0.28, 0.38));
  const samples = rng.int(16, 22);

  // shaping constants, drawn once so candidates are compared on equal terms
  const offsetFor = new Map(pool.map((v) => [v, rng.range(3.0, 4.2)]));
  const fPassExtra = rng.range(0.12, 0.2);
  const exitFactor = rng.range(0.72, 0.88);
  const elFrom = rng.range(0.2, 0.5);
  const elTo = rng.range(-0.5, -0.2);
  const aimLead = rng.range(0.18, 0.24);
  const entryLead = rng.range(0.85, 1.15);
  const exitLead = rng.range(0.95, 1.25);

  const clampF = (v) => Math.max(0.06, Math.min(0.94, v));

  const buildSweep = (visits, dir, azFly) => {
    const rFirst = visits[0].dist;
    const azEntry = azFly[0] - dir * entryLead;
    const azExit = azFly[azFly.length - 1] + dir * Math.PI * exitLead;
    const sweepSpan = azExit - azEntry;
    const fOf = azFly.map((az) => clampF((az - azEntry) / sweepSpan));
    const fPass = Math.min(0.9, Math.max(...fOf) + fPassExtra);

    // keep the approach and departure spirals shallow: cap the radius change
    // per unit of azimuth they have to cover
    const slopeMax = 0.5;
    const rEntry = Math.max(rFirst + 2 * (visits[0].radius + 1), Math.min(cruise, rFirst + slopeMax * sweepSpan * fOf[0] * ((cruise + rFirst) * 0.5)));
    const lastF = fOf[fOf.length - 1];
    const rExitWant = cruise * exitFactor;
    const rLast = visits[visits.length - 1].dist;
    const rExit = Math.min(rExitWant, rLast + slopeMax * sweepSpan * (1 - lastF) * ((rExitWant + rLast) * 0.5));

    const keys = [{ f: 0, r: rEntry }];
    visits.forEach((v, k) => {
      // pass on whichever side keeps the radius profile heading the way it was
      // already going — normally the sunward side, so the camera flies between
      // the star and the world and sees its lit face rather than its night side
      const off = v.radius * offsetFor.get(v) + 1.5;
      const side = v.dist - off > starR * 4.4 ? -1 : 1;
      keys.push({ f: fOf[k], r: v.dist + side * off });
    });
    keys.push({ f: fPass, r: passR }, { f: 1, r: rExit });

    const focusKeys = [{ f: 0, p: new Vector3() }];
    const elKeys = [];
    visits.forEach((v, k) => {
      // worlds keep orbiting while the scene plays: aim at — and ride the
      // orbital plane of — where the world will *be* at the pass, not where it
      // happens to be now
      const P = v.predicted ? v.predicted.clone() : v.node.getWorldPosition(v.world).clone();
      const len = Math.max(1e-3, P.length());
      elKeys.push({ f: fOf[k], el: Math.asin(Math.max(-1, Math.min(1, P.y / len))) });
      // aim at the world itself, but hand the pan a wide window either side
      // of the pass so the swing to it and back to the star stays slow
      focusKeys.push(
        { f: clampF(fOf[k] - aimLead), p: new Vector3() },
        { f: fOf[k], p: P },
        { f: clampF(fOf[k] + aimLead), p: new Vector3() }
      );
    });
    focusKeys.push({ f: fPass, p: new Vector3() }, { f: 1, p: new Vector3() });

    return {
      sweep: polarSweep({ azFrom: azEntry, azTo: azExit, keys, samples, elFrom, elTo, elKeys, focusKeys }),
      fOf,
      azEntry,
      azExit
    };
  };

  const candidates = [];
  for (const dir of [1, -1]) {
    const ordered = pool.slice().sort((x, y) => dir * (azOf(x) - azOf(y)));
    for (const v of ordered) candidates.push({ visits: [v], dir });
    for (let i = 0; i < ordered.length; i++) {
      for (let j = i + 1; j < ordered.length; j++) candidates.push({ visits: [ordered[i], ordered[j]], dir });
    }
  }

  let chosen = null;
  let bestK = Infinity;
  for (const cand of candidates) {
    const probeSweep = buildSweep(cand.visits, cand.dir, cand.visits.map((v) => azOf(v)));
    const k = pathCurvature(probeSweep.sweep.path);
    if (k < bestK) {
      bestK = k;
      chosen = { ...cand, sweep: probeSweep };
    }
  }

  const { visits, dir } = chosen;
  const solveFlybys = ({ sweep, fOf, azEntry, azExit }) => {
    const curve = new CatmullRomCurve3(sweep.path.map((v) => v.clone()), false, 'centripetal');
    const steps = 800;
    const lengths = curve.getLengths(steps);
    const totalLen = lengths[steps];
    const lo = Math.min(azEntry, azExit);
    const hi = Math.max(azEntry, azExit);
    return visits.map((v, k) => {
      const uArc = lengths[Math.round(fOf[k] * steps)] / totalLen;
      // invert eased(p, dwell) = uArc to find when that point is reached
      let a = 0;
      let b = 1;
      for (let it = 0; it < 30; it++) {
        const mid = (a + b) / 2;
        if (easedProgress(mid, dwell) < uArc) a = mid;
        else b = mid;
      }
      const tFly = ((a + b) / 2) * span;

      const phase = v.pivot.rotation.y;
      v.pivot.rotation.y = phase + v.speed * tFly;
      v.pivot.updateMatrixWorld(true);
      v.node.getWorldPosition(v.world);
      v.pivot.rotation.y = phase;
      v.pivot.updateMatrixWorld(true);
      v.predicted = v.world.clone();

      let az = Math.atan2(v.world.z, v.world.x);
      while (az < lo) az += Math.PI * 2;
      while (az > hi) az -= Math.PI * 2;
      return az;
    });
  };

  // pace the flight by distance, so sprawling systems get more time instead of
  // being flown at a much higher turn rate
  const duration = durationFor(
    new CatmullRomCurve3(chosen.sweep.sweep.path.map((p) => p.clone()), false, 'centripetal').getLength()
  );
  const span = pathSpan(duration);

  let azFly = visits.map((v) => azOf(v));
  let built = buildSweep(visits, dir, azFly);
  for (let iter = 0; iter < 4; iter++) {
    const next = solveFlybys(built);
    const delta = Math.max(...next.map((az, i) => Math.abs(az - azFly[i])));
    azFly = next;
    built = buildSweep(visits, dir, azFly);
    if (delta < 0.004) break;
  }
  // the flyby solve ran against the un-conditioned shape, which is identical
  // in length, so the timing of each pass is unchanged
  const shaped = conditionPath(built.sweep.path, built.sweep.focus);
  const path = shaped.path;
  const focus = shaped.focus;

  // final geometric guarantee: every waypoint clears every body, with slack
  // for the spline fitted through them (the director also eases the camera out
  // of anything it still clips, but that should never be needed)
  const obstacles = [{ center: new Vector3(), radius: starR * 3.6 }];
  for (const p of planets) {
    // worlds that are being passed have a predicted position from the solve;
    // the rest are checked where they started, with extra slack for their orbit
    if (p.predicted) p.world.copy(p.predicted);
    else p.node.getWorldPosition(p.world);
    const visited = visits.includes(p);
    obstacles.push({ center: p.world.clone(), radius: (p.radius * 1.9 + 1.5) * (visited ? 1 : 1.35) });
  }
  enforceClearance(path, obstacles, 1.15);

  /* ---- avoidance spheres -------------------------------------------- */
  const avoid = [{ position: new Vector3(), radius: starR * rng.range(3.2, 4.0) }];
  for (const p of planets) avoid.push({ object: p.node, radius: p.radius * 1.9 + 1.5 });

  const nameLetter = String.fromCharCode(65 + rng.int(0, 25));
  const name = `${nameLetter}${String.fromCharCode(65 + rng.int(0, 25))}-${rng.int(1000, 9999)} · ${spec.cls}-Type Star System`;

  return {
    kind: 'starSystem',
    group,
    name,
    seed,
    path,
    focus,
    duration,
    // glide in and out a little quicker, linger through the star pivot
    dwell,
    spin: 0,
    avoid,
    update(dt, t) {
      for (const u of Updaters) u(dt, t);
    }
  };
}
