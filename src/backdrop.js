import {
  AdditiveBlending,
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  Group,
  Points,
  ShaderMaterial,
  Sprite,
  SpriteMaterial,
  Vector3
} from 'three';
import { Rng } from './rng.js';
import { createPointsMaterial, registerPointMaterial, setPointAttributes } from './points.js';
import { sprites } from './textures.js';

const DUST_VERT = /* glsl */ `
  uniform vec3 uCam;
  uniform float uWrap;
  uniform float uScale;
  uniform float uFade;
  attribute float aSize;
  attribute float aAlpha;
  attribute vec3 aColor;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vec3 rel = position - uCam;
    vec3 wrapped = mod(rel + uWrap * 0.5, uWrap) - uWrap * 0.5;
    vec3 world = uCam + wrapped;
    vec4 mv = modelViewMatrix * vec4(world, 1.0);
    gl_Position = projectionMatrix * mv;
    float d = max(0.001, -mv.z);
    float near = smoothstep(uWrap * 0.5, uWrap * uFade, length(wrapped));
    vColor = aColor;
    vAlpha = aAlpha * near;
    gl_PointSize = clamp(aSize * uScale / d, 0.75, 26.0);
  }
`;

const DUST_FRAG = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vec2 d = gl_PointCoord - 0.5;
    float r2 = dot(d, d) * 4.0;
    if (r2 > 1.0) discard;
    gl_FragColor = vec4(vColor, pow(1.0 - r2, 1.6) * vAlpha);
  }
`;

/**
 * The permanent deep sky: distant stars, coloured nebula banks and a drifting
 * volume of near dust. It follows the camera so the horizon never runs out,
 * which is what lets scenes be swapped forever without visible seams.
 */
export function createBackdrop(seed) {
  const rng = new Rng(seed >>> 0);
  const group = new Group();
  const tex = sprites();

  /* ---- distant star field ------------------------------------------ */
  {
    const count = 22000;
    const positions = new Float32Array(count * 3);
    const colors = [];
    const sizes = [];
    const alphas = [];
    const p = new Vector3();
    const c = new Color();
    for (let i = 0; i < count; i++) {
      const r = rng.range(3200, 5200);
      const az = rng.angle();
      const el = Math.asin(rng.range(-1, 1));
      p.set(Math.cos(el) * Math.cos(az) * r, Math.sin(el) * r, Math.cos(el) * Math.sin(az) * r);
      positions[i * 3] = p.x;
      positions[i * 3 + 1] = p.y;
      positions[i * 3 + 2] = p.z;
      // mostly cool white/blue with a sprinkling of warm giants
      const warm = rng.chance(0.22);
      const hue = warm ? rng.range(0.03, 0.11) : rng.range(0.52, 0.68);
      c.setHSL(hue, warm ? rng.range(0.3, 0.6) : rng.range(0.05, 0.45), rng.range(0.55, 0.92));
      colors.push(c.r, c.g, c.b);
      const bright = rng.chance(0.018);
      sizes.push(bright ? rng.range(12, 34) : Math.pow(rng.next(), 2.2) * 6 + 1.4);
      alphas.push(bright ? rng.range(0.8, 1) : rng.range(0.35, 0.9));
    }
    const geo = new BufferGeometry();
    geo.setAttribute('position', new Float32BufferAttribute(positions, 3));
    setPointAttributes(geo, colors, sizes, alphas);
    const mat = createPointsMaterial({ additive: true, maxSize: 18 });
    const points = new Points(geo, mat);
    points.frustumCulled = false;
    group.add(points);
  }

  /* ---- nebula banks ------------------------------------------------ */
  const palette = [
    [0.92, 0.25, 0.55], // magenta
    [0.25, 0.72, 1.0], // cyan
    [0.55, 0.35, 1.0], // violet
    [0.15, 0.95, 0.78], // teal
    [1.0, 0.55, 0.28], // amber
    [0.95, 0.35, 0.9] // pink
  ];
  const banks = rng.int(5, 8);
  for (let b = 0; b < banks; b++) {
    const az = rng.angle();
    const el = rng.range(-0.55, 0.55);
    const r = rng.range(4200, 5400);
    const center = new Vector3(
      Math.cos(el) * Math.cos(az) * r,
      Math.sin(el) * r,
      Math.cos(el) * Math.sin(az) * r
    );
    const [cr, cg, cb] = palette[rng.int(0, palette.length - 1)];
    const puff = rng.int(4, 10);
    for (let i = 0; i < puff; i++) {
      const mat = new SpriteMaterial({
        map: rng.pick(tex.clouds),
        color: new Color(cr, cg, cb),
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
        opacity: rng.range(0.03, 0.09),
        rotation: rng.angle(),
        fog: false
      });
      const s = new Sprite(mat);
      const size = rng.range(900, 2200);
      s.scale.set(size, size, 1);
      s.position.copy(center).add(
        new Vector3(rng.gauss() * 900, rng.gauss() * 500, rng.gauss() * 900)
      );
      group.add(s);
    }
  }

  /* ---- a few colossal, very faint veils for depth ------------------ */
  for (let i = 0; i < 3; i++) {
    const mat = new SpriteMaterial({
      map: tex.halo,
      color: new Color().setHSL(rng.pick([0.62, 0.72, 0.58, 0.9]), 0.55, 0.4),
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      opacity: rng.range(0.012, 0.028),
      fog: false
    });
    const s = new Sprite(mat);
    const az = rng.angle();
    const r = 6200;
    s.position.set(Math.cos(az) * r, rng.range(-1800, 1800), Math.sin(az) * r);
    const size = rng.range(6000, 10000);
    s.scale.set(size, size, 1);
    group.add(s);
  }

  /* ---- near dust --------------------------------------------------- */
  let dust = null;
  {
    const count = 2600;
    const wrap = 340;
    const positions = new Float32Array(count * 3);
    const colors = [];
    const sizes = [];
    const alphas = [];
    const c = new Color();
    for (let i = 0; i < count; i++) {
      positions[i * 3] = rng.range(-wrap / 2, wrap / 2);
      positions[i * 3 + 1] = rng.range(-wrap / 2, wrap / 2);
      positions[i * 3 + 2] = rng.range(-wrap / 2, wrap / 2);
      c.setHSL(rng.range(0.55, 0.68), rng.range(0.05, 0.45), rng.range(0.6, 0.95));
      colors.push(c.r, c.g, c.b);
      sizes.push(rng.range(0.05, 0.42));
      alphas.push(rng.range(0.08, 0.35));
    }
    const geo = new BufferGeometry();
    geo.setAttribute('position', new Float32BufferAttribute(positions, 3));
    setPointAttributes(geo, colors, sizes, alphas);
    const mat = registerPointMaterial(
      new ShaderMaterial({
        uniforms: {
          uCam: { value: new Vector3() },
          uWrap: { value: wrap },
          uScale: { value: 1000 },
          uFade: { value: 0.42 }
        },
        vertexShader: DUST_VERT,
        fragmentShader: DUST_FRAG,
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending
      })
    );
    const points = new Points(geo, mat);
    points.frustumCulled = false;
    dust = { points, geo, mat };
    group.add(points);
  }

  return {
    group,
    /** Keep the sky centred on the observer and let dust wrap around it. */
    update(dt, camPos) {
      group.position.copy(camPos);
      group.rotation.y += dt * 0.0035;
      dust.mat.uniforms.uCam.value.copy(camPos);
    }
  };
}
