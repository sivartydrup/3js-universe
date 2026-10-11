import { AdditiveBlending, BufferAttribute, NoBlending, NormalBlending, ShaderMaterial } from 'three';

const VERT = /* glsl */ `
  uniform float uScale;
  uniform float uMaxSize;
  attribute float aSize;
  attribute float aAlpha;
  attribute vec3 aColor;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vColor = aColor;
    vAlpha = aAlpha;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    float d = max(0.001, -mv.z);
    gl_PointSize = clamp(aSize * uScale / d, 0.75, uMaxSize);
  }
`;

const FRAG = /* glsl */ `
  uniform float uOpacity;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vec2 d = gl_PointCoord - 0.5;
    float r2 = dot(d, d) * 4.0;
    if (r2 > 1.0) discard;
  #ifdef OPAQUE
    gl_FragColor = vec4(vColor, 1.0);
  #else
    float a = pow(1.0 - r2, 1.9);
    gl_FragColor = vec4(vColor, a * vAlpha * uOpacity);
  #endif
  }
`;

const liveMaterials = new Set();
let currentScale = 1000;

/** Register a point-cloud material so the global pixel scale reaches it. */
export function registerPointMaterial(mat) {
  mat.uniforms.uScale.value = currentScale;
  mat.addEventListener('dispose', () => liveMaterials.delete(mat));
  liveMaterials.add(mat);
  return mat;
}

/**
 * Points shrink with distance via gl_PointSize, so the scale factor has to be
 * recomputed whenever the drawing buffer or field of view changes.
 */
export function pointScaleFactor(heightPx, fovDeg) {
  return heightPx / (2 * Math.tan((fovDeg * Math.PI) / 180 / 2));
}

/** Apply a new pixel scale to every live point cloud at once. */
export function setGlobalPointScale(scale) {
  currentScale = scale;
  for (const m of liveMaterials) m.uniforms.uScale.value = scale;
}

/**
 * Soft round point cloud with per-particle colour/size/opacity.
 * Additive by default: overlapping dust accumulates into volumetric glow.
 * `opaque` gives hard-edged depth-writing points (for rocky debris), which
 * keeps them in the opaque pass so they occlude and are occluded correctly.
 */
export function createPointsMaterial({
  additive = true,
  depthWrite = false,
  maxSize = 180,
  opaque = false
} = {}) {
  const mat = new ShaderMaterial({
    uniforms: {
      uScale: { value: currentScale },
      uOpacity: { value: 1 },
      uMaxSize: { value: maxSize }
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: !opaque,
    depthWrite: opaque || depthWrite,
    depthTest: true,
    blending: opaque ? NoBlending : additive ? AdditiveBlending : NormalBlending,
    defines: opaque ? { OPAQUE: '' } : {}
  });
  return registerPointMaterial(mat);
}

/**
 * Fill colour/size/alpha attribute arrays from parallel plain arrays.
 * Returns the mutated geometry for chaining.
 */
export function setPointAttributes(geometry, colors, sizes, alphas) {
  geometry.setAttribute('aColor', new BufferAttribute(new Float32Array(colors), 3));
  geometry.setAttribute('aSize', new BufferAttribute(new Float32Array(sizes), 1));
  geometry.setAttribute('aAlpha', new BufferAttribute(new Float32Array(alphas), 1));
  return geometry;
}
