import {
  ACESFilmicToneMapping,
  Clock,
  HalfFloatType,
  SRGBColorSpace,
  Vector2,
  WebGLRenderTarget,
  WebGLRenderer
} from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

import { createBackdrop } from './backdrop.js';
import { Director, createCamera, createScene } from './director.js';
import { pointScaleFactor, setGlobalPointScale } from './points.js';

/* ------------------------------------------------------------------ *
 * Final grade: cinematic fade to black, vignette, faint dither        *
 * ------------------------------------------------------------------ */

const FinalShader = {
  uniforms: {
    tDiffuse: { value: null },
    uFade: { value: 1 },
    uTime: { value: 0 },
    uResolution: { value: new Vector2(1, 1) }
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uFade;
    uniform float uTime;
    uniform vec2 uResolution;
    varying vec2 vUv;

    float hash(vec2 p) {
      return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
    }

    void main() {
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      float d = length(vUv - 0.5);
      c *= mix(0.70, 1.0, smoothstep(0.98, 0.22, d * 1.42));
      c += (hash(vUv * uResolution + uTime) - 0.5) * 0.012;
      c *= 1.0 - clamp(uFade, 0.0, 1.0);
      gl_FragColor = vec4(max(c, 0.0), 1.0);
    }
  `
};

/* ------------------------------------------------------------------ *
 * Boot                                                                *
 * ------------------------------------------------------------------ */

const params = new URLSearchParams(location.search);
const kindParam = params.get('kind');
const forcedKind = kindParam === 'galaxy' || kindParam === 'system' ? kindParam : null;
const seedParam = params.get('seed');
let seed = null;
if (seedParam !== null && seedParam !== '') {
  seed = Number.isFinite(Number(seedParam)) ? Number(seedParam) >>> 0 : hashString(seedParam);
}

function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const renderer = new WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.12;
renderer.outputColorSpace = SRGBColorSpace;
document.body.appendChild(renderer.domElement);

const scene = createScene();
const camera = createCamera();
const backdrop = createBackdrop(hashString('deep-field-v1'));
scene.add(backdrop.group);
scene.add(camera);

/* composer: HDR, 4x MSAA when the device allows it */
function buildComposer() {
  const dpr = renderer.getPixelRatio();
  const size = renderer.getSize(new Vector2());
  try {
    const rt = new WebGLRenderTarget(
      Math.floor(size.x * dpr),
      Math.floor(size.y * dpr),
      { type: HalfFloatType, samples: 4 }
    );
    return new EffectComposer(renderer, rt);
  } catch (err) {
    console.warn('MSAA render target unavailable, falling back', err);
    return new EffectComposer(renderer);
  }
}

const composer = buildComposer();
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new Vector2(window.innerWidth, window.innerHeight), 0.66, 0.42, 0.68);
composer.addPass(bloom);
composer.addPass(new OutputPass());
const finalPass = new ShaderPass(FinalShader);
composer.addPass(finalPass);

/* ------------------------------------------------------------------ *
 * HUD                                                                 *
 * ------------------------------------------------------------------ */

const label = document.getElementById('label');
const boot = document.getElementById('boot');

const director = new Director({
  renderer,
  scene,
  camera,
  forcedKind,
  seed,
  onSceneChange(world) {
    const kind = world.kind === 'galaxy' ? 'galaxy' : 'star system';
    label.innerHTML = `${world.name}<span class="dim"> · ${kind}</span><span class="seed"> · seed ${world.seed
      .toString(16)
      .padStart(8, '0')}</span>`;
  }
});

/* ------------------------------------------------------------------ *
 * Sizing                                                              *
 * ------------------------------------------------------------------ */

const BASE_FOV = 58;
const BASE_ASPECT = 16 / 9;

/**
 * Keep the horizontal field of view roughly constant on narrow viewports, so
 * portrait/tablet screens still see the whole scene instead of a crop.
 */
function fovFor(aspect) {
  if (aspect >= BASE_ASPECT) return BASE_FOV;
  const halfWidthTan = Math.tan((BASE_FOV * Math.PI) / 360) * BASE_ASPECT;
  const vfov = (2 * Math.atan(halfWidthTan / aspect) * 180) / Math.PI;
  return Math.min(76, vfov);
}

function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  camera.aspect = w / h;
  camera.fov = fovFor(camera.aspect);
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  composer.setSize(w, h);
  bloom.setSize(w, h);
  const height = renderer.getDrawingBufferSize(new Vector2()).y;
  setGlobalPointScale(pointScaleFactor(height, camera.fov));
  finalPass.uniforms.uResolution.value.set(w, h);
}

window.addEventListener('resize', resize);
resize();

/* ------------------------------------------------------------------ *
 * Loop                                                                *
 * ------------------------------------------------------------------ */

if (import.meta.env?.DEV) {
  window.__universe = { director, renderer, composer, scene, camera };
}

window.addEventListener('keydown', (e) => {
  if (e.key === 'n' || e.key === 'N') director.skip();
});

const clock = new Clock();
let elapsed = 0;
let frames = 0;

renderer.setAnimationLoop(() => {
  const dt = Math.min(0.05, clock.getDelta());
  elapsed += dt;

  const fade = director.update(dt);
  backdrop.update(dt, camera.position);

  finalPass.uniforms.uFade.value = fade;
  finalPass.uniforms.uTime.value = elapsed;
  composer.render();

  label.classList.toggle('show', fade < 0.4);

  if (boot && frames++ === 1) boot.classList.add('gone');
});
