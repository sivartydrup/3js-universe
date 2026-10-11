import { CatmullRomCurve3, PerspectiveCamera, Scene, Vector3 } from 'three';
import { Rng } from './rng.js';
import { FADE_IN, FADE_OUT, easedProgress, pathEase, pathSpan, worldLifetime } from './timing.js';
import { createGalaxy } from './galaxy.js';
import { createStarSystem } from './starSystem.js';

const TAU = Math.PI * 2;

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smoother = pathEase;
const damp = (dt, rate) => 1 - Math.exp(-dt * rate);

/** Release every GPU resource owned by a generated world. */
function disposeTree(root) {
  const geometries = new Set();
  const materials = new Set();
  const textures = new Set();
  root.traverse((obj) => {
    if (obj.geometry) geometries.add(obj.geometry);
    const mats = Array.isArray(obj.material) ? obj.material : obj.material ? [obj.material] : [];
    for (const m of mats) materials.add(m);
  });
  for (const m of materials) {
    for (const key of ['map', 'emissiveMap', 'alphaMap', 'normalMap', 'roughnessMap', 'metalnessMap']) {
      const t = m[key];
      // the shared sprite atlas is deliberately kept alive across worlds
      if (t && !t.userData?.shared) textures.add(t);
    }
  }
  for (const g of geometries) g.dispose();
  for (const m of materials) m.dispose();
  for (const t of textures) t.dispose();
}

/**
 * Owns the endless loop of worlds: generate, fly through, fade out, throw away,
 * repeat. Nothing is reused between worlds, so variance never runs out.
 */
export class Director {
  constructor({ renderer, scene, camera, onSceneChange, forcedKind = null, seed = null }) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.onSceneChange = onSceneChange;
    this.forcedKind = forcedKind;
    this.rng = new Rng(seed === null ? undefined : seed);

    this.current = null;
    this.pending = null;
    this.pendingReady = false;
    this.pendingRequestedAt = 0;
    this.t = 0;
    this.fade = 1;
    this.look = new Vector3();
    this.tmpPos = new Vector3();
    this.tmpLook = new Vector3();
    this.rollPhase = this.rng.angle();
    this.driftA = this.rng.angle();
    this.driftB = this.rng.angle();

    this._activate(this._generate(), true);
  }

  /* ---- generation --------------------------------------------------- */

  _generate() {
    const seed = Math.floor(this.rng.next() * 0xffffffff) >>> 0;
    const rng = new Rng(seed);
    const kind =
      this.forcedKind === 'galaxy' || this.forcedKind === 'system'
        ? this.forcedKind
        : rng.chance(0.42)
          ? 'galaxy'
          : 'system';
    const world = kind === 'galaxy' ? createGalaxy(rng.fork(), seed) : createStarSystem(rng.fork(), seed);
    world.rollBase = rng.range(-0.07, 0.07);
    return world;
  }

  _activate(world, first = false) {
    this.scene.add(world.group);
    this.current = world;
    this.t = 0;
    this.fade = 1;
    this.posCurve = new CatmullRomCurve3(world.path.map((p) => p.clone()), false, 'centripetal');
    // the look curve is sampled with the raw parameter of the path curve, so
    // both must carry the same number of control points
    const focus = world.focus.slice();
    while (focus.length < world.path.length) focus.push(focus[focus.length - 1].clone());
    this.lookCurve = new CatmullRomCurve3(focus.slice(0, world.path.length), false, 'centripetal');
    this.posCurve.getPointAt(0, this.tmpPos);
    this.lookCurve.getPointAt(0, this.tmpLook);
    this.camera.position.copy(this.tmpPos);
    this.look.copy(this.tmpLook);
    this.camera.lookAt(this.look);
    if (this.onSceneChange) this.onSceneChange(world);
    if (!first) this.pending = null;
  }

  _requestNext() {
    this.pending = this._generate();
    this.pending.group.visible = false;
    this.scene.add(this.pending.group);
    this.pendingReady = false;
    this.pendingRequestedAt = performance.now();
    // warm the shader cache while the screen is black
    const compile = this.renderer.compileAsync?.(this.scene, this.camera);
    if (compile && typeof compile.then === 'function') {
      compile.then(() => {
        this.pendingReady = true;
      }).catch(() => {
        this.pendingReady = true;
      });
    } else {
      this.renderer.compile?.(this.scene, this.camera);
      this.pendingReady = true;
    }
  }

  _swap() {
    const p = this.pending;
    if (p) {
      // the outgoing group is discarded entirely — no resource leaks, no reuse
      this.scene.remove(this.current.group);
      disposeTree(this.current.group);
      p.group.visible = true;
      this._activate(p, false);
    } else {
      this._activate(this._generate(), false);
    }
  }

  /* ---- per-frame ---------------------------------------------------- */

  /** Advance the camera along the current world's curve. */
  _fly(world, p, dt, elapsed) {
    const eased = easedProgress(clamp01(p), world.dwell || 0);
    // position uses arc length (constant, leisurely speed); the look target is
    // sampled at the *same raw parameter* so waypoint i of the path pairs with
    // waypoint i of the focus list — that is what keeps flybys aimed properly
    const tRaw = this.posCurve.getUtoTmapping(eased);
    this.posCurve.getPoint(tRaw, this.tmpPos);
    this.lookCurve.getPoint(tRaw, this.tmpLook);

    // gentle hand-held drift so the motion never feels mechanical
    const dr = Math.sin(elapsed * 0.13 + this.driftA) * Math.cos(elapsed * 0.07 + this.driftB);
    const du = Math.sin(elapsed * 0.09 + this.driftB) * 0.8;
    this.tmpPos.x += dr * 2.4;
    this.tmpPos.y += du * 1.8;
    this.tmpPos.z += Math.cos(elapsed * 0.11 + this.driftA) * 2.4;

    // keep the observer out of solid bodies (paths are authored clear of them,
    // this is a safety net for pathological random layouts)
    if (world.avoid) {
      for (const a of world.avoid) {
        const center = a.object ? a.object.getWorldPosition(this._c || (this._c = new Vector3())) : a.position;
        const dx = this.tmpPos.x - center.x;
        const dy = this.tmpPos.y - center.y;
        const dz = this.tmpPos.z - center.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < a.radius * a.radius) {
          // eased, never a snap: a hard correction here would read as the
          // camera bouncing off the very body it is passing
          const d = Math.max(1e-3, Math.sqrt(d2));
          const k = (a.radius * 1.02) / d;
          const push = damp(dt, 3.5);
          this.tmpPos.set(
            center.x + dx * (1 + (k - 1) * push),
            center.y + dy * (1 + (k - 1) * push),
            center.z + dz * (1 + (k - 1) * push)
          );
        }
      }
    }

    this.camera.position.copy(this.tmpPos);
    this.look.lerp(this.tmpLook, damp(dt, 1.35));
    this.camera.lookAt(this.look);
    const roll = Math.sin(elapsed * 0.083 + this.rollPhase) * 0.05 + world.rollBase;
    this.camera.rotateZ(roll);
  }

  update(dt) {
    const world = this.current;
    const span = pathSpan(world.duration);
    this.t += dt;
    const elapsed = this.t;

    world.update?.(dt, elapsed, this.camera);
    if (world.spin) world.group.rotation.y += world.spin * dt;

    this._fly(world, clamp01(this.t / span), dt, elapsed);

    // fade envelope: in at the start of a world, out at the end of it
    const fadeOutStart = FADE_IN + world.duration;
    if (this.t < FADE_IN) this.fade = 1 - smoother(this.t / FADE_IN);
    else if (this.t < fadeOutStart) this.fade = 0;
    else this.fade = smoother((this.t - fadeOutStart) / FADE_OUT);

    // start generating the successor once the screen is mostly black, so the
    // build hitch is hidden behind the fade
    if (this.t > fadeOutStart && this.fade > 0.5 && !this.pending) this._requestNext();

    const ready = !this.pending || this.pendingReady || performance.now() - this.pendingRequestedAt > 4000;
    if (this.t >= worldLifetime(world.duration) && ready) this._swap();

    return this.fade;
  }

  /** Skip to the next world immediately (used by the `N` key). */
  skip() {
    if (!this.pending) this._requestNext();
    this.pendingReady = true;
    this.pendingRequestedAt = 0;
    this._swap();
  }
}

export function createCamera() {
  const cam = new PerspectiveCamera(58, 1, 0.5, 40000);
  cam.position.set(0, 0, 100);
  return cam;
}

export function createScene() {
  return new Scene();
}

