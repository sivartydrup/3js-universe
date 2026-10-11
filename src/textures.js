import { CanvasTexture, RepeatWrapping, SRGBColorSpace } from 'three';
import { mulberry32, TAU } from './rng.js';

/* ------------------------------------------------------------------ *
 * Shared sprite textures (generated once, never disposed)             *
 * ------------------------------------------------------------------ */

function canvas2d(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return { c, ctx: c.getContext('2d') };
}

function toTexture(c, { srgb = true, wrap = false } = {}) {
  const t = new CanvasTexture(c);
  if (srgb) t.colorSpace = SRGBColorSpace;
  if (wrap) t.wrapS = t.wrapT = RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

/** Soft radial falloff, `power` controls how tight the core is. */
function radialTexture(size, power) {
  const { c, ctx } = canvas2d(size, size);
  const img = ctx.createImageData(size, size);
  const r = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5 - r) / r;
      const dy = (y + 0.5 - r) / r;
      const d = Math.min(1, Math.sqrt(dx * dx + dy * dy));
      const a = Math.pow(1 - d, power);
      const i = (y * size + x) * 4;
      img.data[i] = 255;
      img.data[i + 1] = 255;
      img.data[i + 2] = 255;
      img.data[i + 3] = Math.round(Math.min(1, Math.max(0, a)) * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  return toTexture(c);
}

/** Wispy cloud sprite: noisy alpha, softer edges than a plain gradient. */
function cloudTexture(seed, size = 256) {
  const { c, ctx } = canvas2d(size, size);
  const img = ctx.createImageData(size, size);
  const rnd = mulberry32(seed);
  const perm = new Uint8Array(512);
  {
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      const t = p[i];
      p[i] = p[j];
      p[j] = t;
    }
    for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  }
  const hash = (ix, iy) => perm[(perm[ix & 255] + iy) & 255] / 255;
  const noise = (x, y) => {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = x - ix;
    const fy = y - iy;
    const ux = fx * fx * (3 - 2 * fx);
    const uy = fy * fy * (3 - 2 * fy);
    const a = hash(ix, iy);
    const b = hash(ix + 1, iy);
    const cc = hash(ix, iy + 1);
    const d = hash(ix + 1, iy + 1);
    return a + (b - a) * ux + (cc - a) * uy + (a - b - cc + d) * ux * uy;
  };
  const fbm = (x, y, oct = 5) => {
    let s = 0;
    let amp = 0.5;
    let f = 1;
    let tot = 0;
    for (let i = 0; i < oct; i++) {
      s += amp * noise(x * f, y * f);
      tot += amp;
      amp *= 0.5;
      f *= 2;
    }
    return s / tot;
  };
  const r = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5 - r) / r;
      const dy = (y + 0.5 - r) / r;
      const d = Math.sqrt(dx * dx + dy * dy);
      let n = fbm((x / size) * 5, (y / size) * 5, 6);
      n = Math.pow(n, 1.35);
      const edge = Math.max(0, 1 - d);
      const a = Math.pow(edge, 2.1) * (0.25 + n * 1.5);
      const i = (y * size + x) * 4;
      const tint = 0.75 + n * 0.5;
      img.data[i] = Math.min(255, 255 * tint);
      img.data[i + 1] = Math.min(255, 255 * tint);
      img.data[i + 2] = 255;
      img.data[i + 3] = Math.round(Math.min(1, Math.max(0, a)) * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  return toTexture(c);
}

let cachedSprites = null;

/** Lazily built, process-wide sprite atlas. */
export function sprites() {
  if (cachedSprites) return cachedSprites;
  const list = [];
  for (let i = 0; i < 5; i++) list.push(cloudTexture(0x51c0 + i * 977));
  cachedSprites = {
    /** Tight, very bright core (star / galactic nucleus). */
    core: radialTexture(256, 4.2),
    /** Wide, gentle halo. */
    halo: radialTexture(256, 2.1),
    /** Wispy nebula sheets. */
    clouds: list
  };
  // these live for the lifetime of the page and are shared by every world, so
  // the per-world cleanup must never dispose them
  for (const t of [cachedSprites.core, cachedSprites.halo, ...list]) {
    t.userData.shared = true;
  }
  return cachedSprites;
}

/* ------------------------------------------------------------------ *
 * Procedural noise used by surface textures                          *
 * ------------------------------------------------------------------ */

/** Tileable-in-x value noise + fbm. `period` must be an integer. */
export function makeNoise(seed) {
  const rnd = mulberry32(seed >>> 0);
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const t = p[i];
    p[i] = p[j];
    p[j] = t;
  }
  const perm = new Uint8Array(512);
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  const hash = (ix, iy) => perm[(perm[ix & 255] + iy) & 255] / 255;

  function noise(x, y, period) {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = x - ix;
    const fy = y - iy;
    const ux = fx * fx * (3 - 2 * fx);
    const uy = fy * fy * (3 - 2 * fy);
    const wrap = (v) => (period ? ((v % period) + period) % period : v);
    const a = hash(wrap(ix), iy);
    const b = hash(wrap(ix + 1), iy);
    const c = hash(wrap(ix), iy + 1);
    const d = hash(wrap(ix + 1), iy + 1);
    return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
  }

  function fbm(x, y, octaves = 5, period = 0) {
    let s = 0;
    let amp = 0.5;
    let f = 1;
    let tot = 0;
    for (let i = 0; i < octaves; i++) {
      s += amp * noise(x * f, y * f, period ? period * f : 0);
      tot += amp;
      amp *= 0.5;
      f *= 2;
    }
    return s / tot;
  }

  return { noise, fbm };
}

/* ------------------------------------------------------------------ *
 * Planet / star surfaces                                             *
 * ------------------------------------------------------------------ */

const mix = (a, b, t) => a + (b - a) * t;

/** Blend two [r,g,b] triples. */
function mixRGB(a, b, t) {
  return [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)];
}

function hsl(h, s, l) {
  // hsl -> rgb, h,s,l in [0,1]
  const f = (n) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    return l - a * Math.max(-1, Math.min(Math.min(k - 3, 9 - k), 1));
  };
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}

/**
 * Build the colour + emissive maps for a planet.
 * Kinds are deliberately artistic rather than astrophysical.
 */
export function planetSurface(rng, kind) {
  const W = 512;
  const H = 256;
  const { c, ctx } = canvas2d(W, H);
  const img = ctx.createImageData(W, H);
  const noise = makeNoise(rng.int(1, 0x7ffffff0));
  const hasEmissive = kind === 'lava' || kind === 'molten';
  let emImg = null;
  if (hasEmissive) emImg = ctx.createImageData(W, H);

  // palettes -------------------------------------------------------
  let pal;
  if (kind === 'gas') {
    const h0 = rng.range(0, 1);
    const h1 = (h0 + rng.range(0.04, 0.35)) % 1;
    pal = [
      hsl(h0, rng.range(0.18, 0.5), rng.range(0.2, 0.34)),
      hsl(mix(h0, h1, 0.35), rng.range(0.3, 0.7), rng.range(0.45, 0.62)),
      hsl(mix(h0, h1, 0.6), rng.range(0.35, 0.8), rng.range(0.62, 0.8)),
      hsl(h1, rng.range(0.25, 0.6), rng.range(0.4, 0.6)),
      hsl(h0, rng.range(0.05, 0.25), rng.range(0.75, 0.92))
    ];
  } else if (kind === 'ice') {
    pal = [
      hsl(rng.range(0.5, 0.62), 0.5, 0.35),
      hsl(rng.range(0.5, 0.62), 0.32, 0.62),
      hsl(rng.range(0.5, 0.6), 0.12, 0.82),
      hsl(0.58, 0.05, 0.97)
    ];
  } else if (kind === 'lava' || kind === 'molten') {
    pal = [
      [10, 8, 10],
      hsl(rng.range(0.02, 0.08), 0.7, 0.16),
      hsl(rng.range(0.02, 0.08), 0.85, 0.32)
    ];
  } else if (kind === 'desert') {
    pal = [
      hsl(rng.range(0.04, 0.1), 0.65, 0.24),
      hsl(rng.range(0.05, 0.1), 0.6, 0.44),
      hsl(rng.range(0.07, 0.12), 0.5, 0.68),
      hsl(rng.range(0.08, 0.12), 0.28, 0.88)
    ];
  } else {
    // rocky / terran / ocean
    const hue = rng.range(0, 1);
    pal = [
      hsl(mix(hue, 0.6, 0.85), rng.range(0.6, 0.9), rng.range(0.1, 0.2)), // deep water
      hsl(mix(hue, 0.55, 0.7), rng.range(0.5, 0.8), rng.range(0.26, 0.4)), // shelf
      hsl(mix(hue, 0.22, 0.55), rng.range(0.35, 0.6), rng.range(0.32, 0.5)), // land
      hsl(mix(hue, 0.13, 0.35), rng.range(0.25, 0.5), rng.range(0.45, 0.66)), // highland
      hsl(0.09, 0.15, 0.9) // peaks
    ];
  }

  const seaLevel = kind === 'ocean' ? rng.range(0.6, 0.72) : rng.range(0.36, 0.56);
  const bands = kind === 'gas' ? rng.range(5, 11) : 0;
  const warp = rng.range(0.5, 2.4);
  const capsuleW = rng.range(8, 26);
  const polar = rng.range(0.68, 0.86);
  const grain = rng.range(0.03, 0.1);

  for (let y = 0; y < H; y++) {
    const lat = y / H;
    const dy = lat - 0.5;
    for (let x = 0; x < W; x++) {
      const u = x / W;
      const i = (y * W + x) * 4;
      let r;
      let g;
      let b;

      if (kind === 'gas') {
        const turb = noise.fbm(u * 3, lat * 5, 5, 3) - 0.5;
        const storm = noise.fbm(u * 7 + 11, lat * 9 + 3, 4, 7) - 0.5;
        const v = lat * bands * 2 + turb * warp * 3 + storm * 0.6;
        const t = 0.5 + 0.5 * Math.sin(v * Math.PI);
        const idx = t * (pal.length - 1);
        const k = Math.min(pal.length - 2, Math.floor(idx));
        const f = idx - k;
        [r, g, b] = mixRGB(pal[k], pal[k + 1], f);
        // faint zonal shading + a soft polar hood
        const shade = 1 - 0.14 * Math.abs(dy) * 2;
        const hood = Math.max(0, (Math.abs(dy) * 2 - polar) / (1 - polar));
        r = mix(r * shade, 210, hood * 0.5);
        g = mix(g * shade, 220, hood * 0.5);
        b = mix(b * shade, 245, hood * 0.5);
      } else if (kind === 'ice') {
        const t = noise.fbm(u * 5, lat * 6, 6, 5);
        const crack = Math.pow(Math.max(0, 1 - Math.abs(t - 0.5) * 7), 2.5);
        const idx = t * (pal.length - 1);
        const k = Math.min(pal.length - 2, Math.floor(idx));
        const f = idx - k;
        [r, g, b] = mixRGB(pal[k], pal[k + 1], f);
        r = mix(r, 225, crack * 0.7);
        g = mix(g, 240, crack * 0.7);
        b = mix(b, 255, crack * 0.7);
      } else if (hasEmissive) {
        const t = noise.fbm(u * 3.5, lat * 4, 5, 3.5);
        const crack = Math.pow(Math.max(0, 1 - Math.abs(t - 0.5) * 5.5), 3.0);
        const idx = t * (pal.length - 1);
        const k = Math.min(pal.length - 2, Math.floor(idx));
        [r, g, b] = mixRGB(pal[k], pal[k + 1], idx - k);
        const hot = crack * crack;
        const ei = i;
        emImg.data[ei] = Math.min(255, hot * 255);
        emImg.data[ei + 1] = Math.min(255, hot * 165);
        emImg.data[ei + 2] = Math.min(255, hot * 70);
        emImg.data[ei + 3] = 255;
      } else {
        let h = noise.fbm(u * 4, lat * 5, 6, 4) - 0.5;
        h *= 1 - 0.25 * Math.abs(dy) * 2;
        const land = h + seaLevel - 0.5;
        let t;
        if (land < 0) t = Math.max(0, (land + 0.5) / 0.5) * 0.5;
        else t = 0.5 + Math.min(1, land * 3.2) * 0.5;
        const idx = Math.min(pal.length - 1.0001, Math.max(0, t * (pal.length - 1)));
        const k = Math.min(pal.length - 2, Math.floor(idx));
        [r, g, b] = mixRGB(pal[k], pal[k + 1], idx - k);
        // polar caps
        const cap = Math.max(0, (Math.abs(dy) * 2 - polar) / (1 - polar));
        const iceMix = Math.min(1, cap * 1.6);
        r = mix(r, 232, iceMix);
        g = mix(g, 242, iceMix);
        b = mix(b, 255, iceMix);
      }

      const n = (noise.noise(u * capsuleW, lat * capsuleW * 2, capsuleW) - 0.5) * grain * 255;
      img.data[i] = Math.max(0, Math.min(255, r + n));
      img.data[i + 1] = Math.max(0, Math.min(255, g + n));
      img.data[i + 2] = Math.max(0, Math.min(255, b + n));
      img.data[i + 3] = 255;
    }
  }

  ctx.putImageData(img, 0, 0);
  const map = toTexture(c);

  let emissiveMap = null;
  if (hasEmissive) {
    const e = canvas2d(W, H);
    e.ctx.putImageData(emImg, 0, 0);
    emissiveMap = toTexture(e.c);
  }
  return { map, emissiveMap };
}

/** Granulation texture for a stellar photosphere. */
export function starSurface(seed) {
  const W = 384;
  const H = 192;
  const { c, ctx } = canvas2d(W, H);
  const img = ctx.createImageData(W, H);
  const noise = makeNoise(seed);
  for (let y = 0; y < H; y++) {
    const lat = y / H;
    for (let x = 0; x < W; x++) {
      const u = x / W;
      const gran = noise.fbm(u * 22, lat * 26, 5, 22);
      const cells = noise.fbm(u * 60 + 5, lat * 64 + 9, 4, 60);
      const v = Math.pow(Math.min(1, gran * 0.75 + cells * 0.45), 1.1);
      const i = (y * W + x) * 4;
      img.data[i] = Math.min(255, 190 + v * 120);
      img.data[i + 1] = Math.min(255, 150 + v * 110);
      img.data[i + 2] = Math.min(255, 110 + v * 100);
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return toTexture(c);
}

/** Concentric ring bands with gaps, mapped radially by the caller. */
export function ringTexture(rng) {
  const W = 1024;
  const H = 48;
  const { c, ctx } = canvas2d(W, H);
  const img = ctx.createImageData(W, H);
  const noise = makeNoise(rng.int(1, 0x7ffffff0));
  const hue = rng.range(0, 1);
  const bands = rng.int(24, 60);
  const base = hsl(hue % 1, rng.range(0.05, 0.35), rng.range(0.62, 0.85));
  for (let x = 0; x < W; x++) {
    const u = x / W;
    let a = 0.55 + 0.45 * Math.sin(u * bands * TAU * 0.15 + noise.noise(u * 40, 0.5, 40) * 6);
    a *= 0.55 + 0.45 * noise.fbm(u * 18, 0.25, 4, 18);
    // hard gaps
    for (let g = 0; g < 5; g++) {
      const gx = 0.12 + g * 0.19 + noise.noise(u * 3, g * 1.7, 3) * 0.05;
      const gw = 0.004 + noise.noise(u * 5, g * 3.1, 5) * 0.012;
      if (Math.abs(u - gx) < gw) a *= 0.06;
    }
    // fade the outer and inner edges
    const edge = Math.min(1, Math.min(u, 1 - u) / 0.08);
    a *= 0.5 + 0.5 * edge;
    const shade = 0.75 + 0.35 * noise.fbm(u * 7, 0.7, 4, 7);
    for (let y = 0; y < H; y++) {
      const i = (y * W + x) * 4;
      img.data[i] = Math.min(255, base[0] * shade);
      img.data[i + 1] = Math.min(255, base[1] * shade);
      img.data[i + 2] = Math.min(255, base[2] * shade);
      img.data[i + 3] = Math.round(Math.max(0, Math.min(1, a)) * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  return toTexture(c);
}

/** Give a ring geometry radial UVs so a 1-D texture maps along its radius. */
export function radialRingUVs(geometry, inner, outer) {
  const pos = geometry.attributes.position;
  const uv = geometry.attributes.uv;
  const v = { x: 0, z: 0 };
  for (let i = 0; i < pos.count; i++) {
    v.x = pos.getX(i);
    v.z = pos.getZ(i);
    const r = Math.sqrt(v.x * v.x + v.z * v.z);
    uv.setXY(i, (r - inner) / (outer - inner), 0.5);
  }
  uv.needsUpdate = true;
}
