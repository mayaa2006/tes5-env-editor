/**
 * Particle systems (mist, smoke, fire, sparks) drawn as a still cloud: where a system's particles are at one moment,
 * worked out from its emitter (shape, speed, direction, life) and modifiers (gravity, colour and size over life,
 * sprite-sheet frames). Not animated, so the scene still only redraws when something changes.
 */
import * as THREE from 'three';
import type { NifParticles } from '@tes5/assets';

/** At most this many particles a system (some fire and spark systems spawn hundreds a second). */
const MAX_PARTICLES = 300;

/** A small seeded random generator, so a system looks the same every time it's loaded. */
function random(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** BSPSysSimpleColorModifier: colour 1, blending to 2, to 3, faded in and out at the ends of the particle's life. */
function colorAt(p: NifParticles, t: number): [number, number, number, number] {
  const c = p.colorOverLife;
  let rgba = [...p.color] as [number, number, number, number];
  if (c) {
    const [c1, c2, c3] = c.colors as [[number, number, number, number], [number, number, number, number], [number, number, number, number]];
    const mix = (a: number[], b: number[], k: number) => a.map((v, i) => lerp(v, b[i]!, Math.max(0, Math.min(1, k))));
    const col = t <= c.c1End ? c1 : t < c.c2Start ? mix(c1, c2, (t - c.c1End) / Math.max(1e-4, c.c2Start - c.c1End)) : t <= c.c2End ? c2 : t < c.c3Start ? mix(c2, c3, (t - c.c2End) / Math.max(1e-4, c.c3Start - c.c2End)) : c3;
    rgba = rgba.map((v, i) => v * col[i]!) as [number, number, number, number];
    if (c.fadeIn > 0 && t < c.fadeIn) rgba[3] *= t / c.fadeIn;
    if (c.fadeOut > 0 && t > 1 - c.fadeOut) rgba[3] *= (1 - t) / c.fadeOut;
  }
  return rgba;
}

/** BSPSysScaleModifier: multipliers spread evenly over the particle's life. */
function scaleAt(p: NifParticles, t: number): number {
  const s = p.scaleOverLife;
  if (!s?.length) return 1;
  if (s.length === 1) return s[0]!;
  const x = t * (s.length - 1);
  const i = Math.min(s.length - 2, Math.floor(x));
  return lerp(s[i]!, s[i + 1]!, x - i);
}

const VERTEX = /* glsl */ `
attribute vec4 pcolor;
attribute vec4 rect;
attribute float size;
uniform float viewportHeight;
varying vec4 vColor;
varying vec4 vRect;
void main() {
  vColor = pcolor;
  vRect = rect;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  // World-size sprites: the diameter in units, as pixels at this distance.
  gl_PointSize = max(1.0, size * projectionMatrix[1][1] * viewportHeight * 0.5 / max(1.0, -mv.z));
}`;

const FRAGMENT = /* glsl */ `
uniform sampler2D map;
uniform bool hasMap;
varying vec4 vColor;
varying vec4 vRect;
void main() {
  vec4 tex = hasMap ? texture2D(map, vRect.xy + gl_PointCoord * vRect.zw) : vec4(1.0, 1.0, 1.0, 1.0 - smoothstep(0.2, 0.5, length(gl_PointCoord - 0.5)));
  gl_FragColor = tex * vColor;
  if (gl_FragColor.a < 0.004) discard;
  #include <colorspace_fragment>
}`;

/** The cloud for one system, in the mesh's file space; its texture is set when it arrives. */
export function buildParticles(p: NifParticles, texture: Promise<THREE.Texture | null> | undefined): THREE.Points {
  const rand = random(p.blockIndex * 7919 + Math.round(p.radius * 13) + 1);
  const life = Math.max(0.05, p.lifeSpan);
  const count = Math.max(1, Math.min(MAX_PARTICLES, Math.round((p.birthRate || 4) * life)));
  const m = new THREE.Matrix4().fromArray(p.emitter.matrix);
  const rot = new THREE.Matrix3().setFromMatrix4(m);
  const g = p.gravity ? new THREE.Vector3(...p.gravity) : undefined;
  // (Material base colour: the effect shader's tint times its strength.)
  const mat = p.material;
  const tint = [mat.emissive[0] || 1, mat.emissive[1] || 1, mat.emissive[2] || 1].map((v) => v * Math.max(0.2, Math.min(mat.emissiveMultiple || 1, 3)));
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 4);
  const rects = new Float32Array(count * 4);
  const sizes = new Float32Array(count);
  const [sx, sy, sz] = p.emitter.size;
  const pos = new THREE.Vector3();
  const dir = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    // Born at a steady rate: spread evenly over one life, as a system that has been running a while.
    const lifeI = Math.max(0.05, life + (rand() * 2 - 1) * p.lifeSpanVariation);
    const age = ((i + rand()) / count) * lifeI;
    const t = age / lifeI;
    // Where it starts: anywhere in the emitter's volume (its own space).
    if (p.emitter.shape === 'box') pos.set((rand() - 0.5) * sx, (rand() - 0.5) * sy, (rand() - 0.5) * sz);
    else if (p.emitter.shape === 'cylinder') {
      const a = rand() * Math.PI * 2;
      const r = Math.sqrt(rand()) * sx;
      pos.set(Math.cos(a) * r, Math.sin(a) * r, (rand() - 0.5) * sy);
    } else {
      const u = rand() * 2 - 1;
      const a = rand() * Math.PI * 2;
      const r = Math.cbrt(rand()) * sx;
      const k = Math.sqrt(1 - u * u);
      pos.set(Math.cos(a) * k * r, Math.sin(a) * k * r, u * r);
    }
    pos.applyMatrix4(m);
    // Which way it goes: the declination from the emitter's up axis, and the planar angle around it.
    const decl = p.declination + (rand() * 2 - 1) * p.declinationVariation;
    const planar = p.planarAngle + (rand() * 2 - 1) * p.planarAngleVariation;
    dir.set(Math.sin(decl) * Math.cos(planar), Math.sin(decl) * Math.sin(planar), Math.cos(decl)).applyMatrix3(rot).normalize();
    const speed = Math.max(0, p.speed + (rand() * 2 - 1) * p.speedVariation);
    pos.addScaledVector(dir, speed * age);
    if (g) pos.addScaledVector(g, 0.5 * age * age);
    positions.set([pos.x, pos.y, pos.z], i * 3);
    const c = colorAt(p, t);
    colors.set([c[0] * tint[0]!, c[1] * tint[1]!, c[2] * tint[2]!, Math.min(1, c[3] * (mat.alpha || 1))], i * 4);
    const frame = p.frames[p.animatedFrames ? Math.min(p.frames.length - 1, Math.floor(t * p.frames.length)) : Math.floor(rand() * p.frames.length)]!;
    rects.set(frame, i * 4);
    sizes[i] = 2 * Math.max(0.5, p.radius + (rand() * 2 - 1) * p.radiusVariation) * scaleAt(p, t);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('pcolor', new THREE.BufferAttribute(colors, 4));
  geo.setAttribute('rect', new THREE.BufferAttribute(rects, 4));
  geo.setAttribute('size', new THREE.BufferAttribute(sizes, 1));
  geo.computeBoundingSphere();
  if (geo.boundingSphere) geo.boundingSphere.radius += Math.max(...sizes);
  const uniforms = { map: { value: null as THREE.Texture | null }, hasMap: { value: false }, viewportHeight: { value: 800 } };
  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    transparent: true,
    depthWrite: false,
    blending: mat.additive || !mat.alphaBlend ? THREE.AdditiveBlending : THREE.NormalBlending,
  });
  const points = new THREE.Points(geo, material);
  points.name = p.name;
  points.userData.particles = true;
  // Not something to click on: the effect's own marker is.
  points.raycast = () => undefined;
  // (On the material, which every placed copy shares: clone() leaves an object's own render hooks behind.)
  material.onBeforeRender = (renderer) => {
    uniforms.viewportHeight.value = renderer.getDrawingBufferSize(SIZE).y;
  };
  void texture?.then((t) => {
    if (!t) return;
    uniforms.map.value = t;
    uniforms.hasMap.value = true;
    material.needsUpdate = true;
  });
  return points;
}

const SIZE = new THREE.Vector2();
