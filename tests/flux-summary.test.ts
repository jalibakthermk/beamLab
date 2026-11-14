import { describe, expect, it } from 'vitest';
import { flux, solidAngleWeights } from '../core/geometry/flux';
import { summarize } from '../core/analysis/summary';
import { parseIes } from '../core/io/ies';
import { createDataset } from '../core/model/dataset';
import { GAUSS, UNIFORM_LIMITED, UNIFORM_SPHERE_CD } from './fixtures/generate';
import { fixture } from './load-fixture';

const R = Math.PI / 180;

describe('flux', () => {
  it('uniform full sphere (Type C file) gives 4πI', () => {
    const { dataset } = parseIes(fixture('uniform-sphere-typeC.ies'));
    expect(flux(dataset)).toBeCloseTo(4 * Math.PI * UNIFORM_SPHERE_CD, 6);
  });

  it('uniform limited range gives I · ΔH · (sin Vmax − sin Vmin), angles in radians', () => {
    const { dataset } = parseIes(fixture('uniform-limited-typeA.ies'));
    const { cd, hMin, hMax, vMin, vMax } = UNIFORM_LIMITED;
    const expected = cd * (hMax - hMin) * R * (Math.sin(vMax * R) - Math.sin(vMin * R));
    expect(flux(dataset)).toBeCloseTo(expected, 9);
  });

  it('Gaussian spot matches the small-angle analytic flux I0 · 2π σH σV · cos V0 within 0.5%', () => {
    const { dataset } = parseIes(fixture('gaussian-spot-typeA.ies'));
    const expected = GAUSS.peak * 2 * Math.PI * GAUSS.sh * R * GAUSS.sv * R * Math.cos(GAUSS.v0 * R);
    expect(Math.abs(flux(dataset) / expected - 1)).toBeLessThan(0.005);
  });

  it('ignores cells that touch NaN', () => {
    const values = new Float64Array([1, 1, 1, 1, 1, NaN]); // 3 H × 2 V; right cell has a NaN corner
    const ds = createDataset({
      id: 'n', name: 'n', kind: 'intensity', grid: { h: [0, 10, 20], v: [0, 10] }, values,
      meta: { keywords: [], lumens: null, multiplier: 1, ballastFactor: 1, ballastLampFactor: 1, watts: 0, dimensions: null, sourceType: 'A', sourceFormat: 'synthetic' },
      provenance: null,
    });
    expect(flux(ds)).toBeCloseTo(10 * R * Math.sin(10 * R), 12);
  });

  it('solid-angle weights of a full-sphere grid sum to 4π', () => {
    const h: number[] = [];
    const v: number[] = [];
    for (let a = -180; a <= 180; a += 7.5) h.push(a);
    for (let a = -90; a <= 90; a += 7.5) v.push(a);
    const w = solidAngleWeights({ h, v });
    expect(w.reduce((s, x) => s + x, 0)).toBeCloseTo(4 * Math.PI, 12);
  });
});

describe('summary', () => {
  it('recovers the Gaussian peak value and position', () => {
    const s = summarize(parseIes(fixture('gaussian-spot-typeA.ies')).dataset);
    expect(s.maxIntensity).toBe(GAUSS.peak);
    expect(s.maxAt).toEqual({ h: GAUSS.h0, v: GAUSS.v0 });
  });

  it('reports range, grid step and flux in coverage', () => {
    const { dataset } = parseIes(fixture('uniform-limited-typeA.ies'));
    const s = summarize(dataset);
    expect(s.range).toEqual({ hMin: -45, hMax: 45, vMin: -15, vMax: 15 });
    expect(s.step).toEqual({ h: { min: 5, max: 5 }, v: { min: 1, max: 1 } });
    expect(s.flux).toBe(flux(dataset));
    expect(s.maxIntensity).toBe(UNIFORM_LIMITED.cd);
  });
});
