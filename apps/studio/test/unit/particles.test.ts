import { describe, expect, it } from 'vitest';
import type { NifMaterial, NifParticles } from '@tes5/assets';
import { buildParticles } from '../../src/views/scene/particles3d';

const material = { shader: 'effect', textures: [], alpha: 1, alphaBlend: true, alphaTest: false, alphaThreshold: 128, twoSided: true, vertexColors: false, modelSpaceNormals: false, emissive: [1, 1, 1], emissiveMultiple: 1, uvOffset: [0, 0], uvScale: [1, 1], glossiness: 0, specularColor: [0, 0, 0], specularStrength: 0, shaderType: 0 } as NifMaterial;

/** The smoke over Skyrim's campfire (campfire01burning.nif), as the NIF reader gives it. */
function smoke(over: Partial<NifParticles> = {}): NifParticles {
  return {
    name: 'smoke02',
    blockIndex: 61,
    material,
    emitter: { shape: 'cylinder', size: [16.2, 8.96, 0], matrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 55, 1]) },
    speed: 60,
    speedVariation: 12,
    declination: 0,
    declinationVariation: 0,
    planarAngle: 0,
    planarAngleVariation: 0,
    color: [1, 1, 1, 1],
    radius: 10,
    radiusVariation: 1.2,
    lifeSpan: 2,
    lifeSpanVariation: 0.4,
    birthRate: 15,
    colorOverLife: { fadeIn: 0.05, fadeOut: 0.35, c1End: 0.1, c2Start: 0.45, c2End: 0.5, c3Start: 0.9, colors: [[1, 1, 1, 1], [0.5, 0.5, 0.5, 1], [0.2, 0.2, 0.2, 1]] },
    frames: [[0, 0, 0.5, 0.5], [0.5, 0, 0.5, 0.5]],
    animatedFrames: true,
    ...over,
  };
}

describe('particle systems in the viewport', () => {
  it('spreads a system over one life: rising from its emitter, fading out, stepping through its frames', () => {
    const p = buildParticles(smoke(), undefined);
    const pos = p.geometry.getAttribute('position');
    // 15 a second for 2 seconds.
    expect(pos.count).toBe(30);
    const zs = Array.from({ length: pos.count }, (_, i) => pos.getZ(i));
    // Out of the top of the emitter (at 55, 9 units tall) and up at 48–72 units a second.
    expect(Math.min(...zs)).toBeGreaterThan(55 - 4.5);
    expect(Math.max(...zs)).toBeLessThan(55 + 4.5 + 72 * 2.4);
    for (let i = 0; i < pos.count; i++) expect(Math.hypot(pos.getX(i), pos.getY(i))).toBeLessThanOrEqual(16.2 + 1e-3);
    // The oldest are faded and greyer than the youngest; each particle shows the frame for its age.
    const alpha = p.geometry.getAttribute('pcolor');
    const oldest = zs.indexOf(Math.max(...zs));
    expect(alpha.getW(oldest)).toBeLessThan(0.5);
    const rect = p.geometry.getAttribute('rect');
    expect([rect.getX(0), rect.getX(pos.count - 1)]).toEqual([0, 0.5]);
    // Sizes are diameters in units: 2 × (10 ± 1.2).
    const size = p.geometry.getAttribute('size');
    for (let i = 0; i < size.count; i++) expect(size.getX(i)).toBeGreaterThanOrEqual(17.6 - 1e-3);
    // Looks the same every time it's loaded, and isn't something the mouse picks.
    expect(Array.from(buildParticles(smoke(), undefined).geometry.getAttribute('position').array)).toEqual(Array.from(pos.array));
    const hits: unknown[] = [];
    p.raycast({} as never, hits as never);
    expect(hits).toEqual([]);
  });

  it('caps busy systems and falls with gravity', () => {
    const sparks = buildParticles(smoke({ birthRate: 2000, gravity: [0, 0, -500], speed: 0, speedVariation: 0, colorOverLife: undefined }), undefined);
    const pos = sparks.geometry.getAttribute('position');
    expect(pos.count).toBe(300);
    expect(Math.min(...Array.from({ length: pos.count }, (_, i) => pos.getZ(i)))).toBeLessThan(0);
  });
});
