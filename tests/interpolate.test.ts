import { describe, expect, it } from 'vitest';
import { bilinear, bracket, sample } from '../core/geometry/interpolate';
import { chooseTargetStep, resample, resampleToTypeA } from '../core/geometry/resample';
import { anglesToVector } from '../core/geometry/coords';
import { createDataset, type PhotometricDataset } from '../core/model/dataset';
import { range } from './fixtures/generate';

function ds(h: number[], v: number[], f: (h: number, v: number) => number): PhotometricDataset {
  const values = new Float64Array(h.length * v.length);
  v.forEach((vv, iv) => h.forEach((hh, ih) => (values[iv * h.length + ih] = f(hh, vv))));
  return createDataset({
    id: 't',
    name: 't',
    kind: 'intensity',
    grid: { h, v },
    values,
    meta: {
      keywords: [],
      lumens: null,
      multiplier: 1,
      ballastFactor: 1,
      ballastLampFactor: 1,
      watts: 0,
      dimensions: null,
      sourceType: 'A',
      sourceFormat: 'synthetic',
    },
    provenance: null,
  });
}

describe('bracket', () => {
  const axis = [-10, 0, 5, 20];
  it('finds the interval and fraction', () => {
    expect(bracket(axis, 2.5)).toEqual({ i0: 1, i1: 2, t: 0.5 });
    expect(bracket(axis, -10)).toEqual({ i0: 0, i1: 1, t: 0 });
    expect(bracket(axis, 20)).toEqual({ i0: 2, i1: 3, t: 1 });
  });
  it('returns null outside the axis but tolerates rounding noise at the ends', () => {
    expect(bracket(axis, 20.001)).toBeNull();
    expect(bracket(axis, -10.5)).toBeNull();
    expect(bracket(axis, 20 + 1e-12)).toEqual({ i0: 2, i1: 3, t: 1 });
    expect(bracket(axis, NaN)).toBeNull();
  });
  it('handles a single-point axis', () => {
    expect(bracket([0], 0)).toEqual({ i0: 0, i1: 0, t: 0 });
    expect(bracket([0], 0.1)).toBeNull();
  });
});

describe('sample (bilinear)', () => {
  const plane = ds([-10, 0, 10], [-5, 0, 5], (h, v) => 100 + 2 * h + 3 * v + 0.1 * h * v);

  it('returns exact node values and reproduces a bilinear function exactly', () => {
    expect(sample(plane, 10, 5)).toBe(100 + 20 + 15 + 5);
    for (const [h, v] of [[2.5, -1], [-7, 4.2], [9.9, -4.9]] as const) {
      expect(sample(plane, h, v)).toBeCloseTo(100 + 2 * h + 3 * v + 0.1 * h * v, 12);
    }
  });

  it('returns NaN outside coverage', () => {
    expect(sample(plane, 10.5, 0)).toBeNaN();
    expect(sample(plane, 0, -6)).toBeNaN();
    const narrowed = { ...plane, coverage: { hMin: -10, hMax: 0, vMin: -5, vMax: 5 } };
    expect(sample(narrowed, 5, 0)).toBeNaN();
  });

  it('returns NaN when a contributing corner is NaN, but exact values at nodes next to NaN', () => {
    const holes = ds([0, 1], [0, 1], (h, v) => (h === 1 && v === 1 ? NaN : 10));
    expect(sample(holes, 0.5, 0.5)).toBeNaN();
    expect(sample(holes, 1, 0)).toBe(10);
    expect(sample(holes, 0.5, 0)).toBe(10);
  });

  it('bilinear works on raw arrays', () => {
    expect(bilinear([0, 1], [0, 1], [0, 1, 2, 3], 0.5, 0.5)).toBe(1.5);
  });
});

describe('resampling', () => {
  it('chooses the finest source step', () => {
    expect(chooseTargetStep([0, 30, 60], [0, 10, 20, 22.5])).toBe(2.5);
    expect(chooseTargetStep([0], [0, 0.1, 0.2])).toBe(0.1);
  });

  it('resample() onto a target Type A grid samples the source and records provenance', () => {
    const src = ds([-10, 0, 10], [-5, 0, 5], (h, v) => h + v);
    const out = resample(src, { h: [-10, -5, 0, 15], v: [0, 2.5] });
    expect(Array.from(out.values)).toEqual([-10, -5, 0, NaN, -7.5, -2.5, 2.5, NaN]);
    expect(out.provenance?.op).toBe('resample');
    expect(out.provenance?.inputs).toEqual(['t']);
    expect(out.coverage).toEqual({ hMin: -10, hMax: 0, vMin: 0, vMax: 2.5 });
  });

  it('converts a uniform Type C full sphere to a fully covered Type A grid', () => {
    const c = [0, 90, 180, 270, 360];
    const g = [0, 45, 90, 135, 180];
    const values = new Float64Array(c.length * g.length).fill(7);
    const out = resampleToTypeA({ type: 'C', h: c, v: g, values });
    expect(out).not.toBeNull();
    expect(out!.step).toBe(45);
    expect(out!.grid.h[0]).toBe(-180);
    expect(out!.grid.h.at(-1)).toBe(180);
    expect(out!.grid.v).toEqual([-90, -45, 0, 45, 90]);
    expect(Array.from(out!.values).every((x) => Math.abs(x - 7) < 1e-12)).toBe(true);
  });

  it('crops a Type B forward-hemisphere source to H -90..90 and matches the source function', () => {
    const h = [-90, -45, 0, 45, 90];
    const v = [-90, -45, 0, 45, 90];
    const f = (hh: number, vv: number) => anglesToVector('B', hh, vv)[0] * 100; // forward component
    const values = new Float64Array(25);
    v.forEach((vv, iv) => h.forEach((hh, ih) => (values[iv * 5 + ih] = f(hh, vv))));
    const out = resampleToTypeA({ type: 'B', h, v, values })!;
    expect(out.grid.h[0]).toBe(-90);
    expect(out.grid.h.at(-1)).toBe(90);
    // Straight ahead is a node in both systems
    const i0 = out.grid.h.indexOf(0);
    const j0 = out.grid.v.indexOf(0);
    expect(out.values[j0 * out.grid.h.length + i0]).toBeCloseTo(100, 12);
  });

  describe('grid-size limit is based on the area the source covers, not the full sphere', () => {
    // Small Type B source with a 0.1° V step: full sphere at 0.1° would be 6.5 M points
    const h = range(-10, 10, 0.5);
    const v = range(-4, 4, 0.1);
    const PEAK = { h: 1.5, v: -0.6, cd: 36181.4 };
    const f = (hh: number, vv: number) =>
      hh === PEAK.h && vv === PEAK.v ? PEAK.cd : 20000 * Math.exp(-((hh - 1.5) ** 2) / 8) * (vv < -0.6 ? Math.exp(vv + 0.6) : 1);
    const values = new Float64Array(h.length * v.length);
    v.forEach((vv, iv) => h.forEach((hh, ih) => (values[iv * h.length + ih] = f(hh, vv))));

    it('keeps the source step when the covered area fits under the limit', () => {
      const out = resampleToTypeA({ type: 'B', h, v, values }, { maxPoints: 100_000 })!;
      expect(out.requestedStep).toBe(0.1);
      expect(out.step).toBe(0.1);
      expect(out.coarsened).toBe(false);
      expect(out.grid.h[0]).toBeGreaterThanOrEqual(-10 - 1e-9);
      expect(out.grid.h.at(-1)).toBeLessThanOrEqual(10 + 1e-9);
      expect(out.grid.v[0]).toBeGreaterThanOrEqual(-4 - 1e-9);
      expect(out.grid.v.at(-1)).toBeLessThanOrEqual(4 + 1e-9);
    });

    it('keeps a peak that sits on a fine source node', () => {
      const out = resampleToTypeA({ type: 'B', h, v, values }, { maxPoints: 100_000 })!;
      const ih = out.grid.h.indexOf(PEAK.h);
      const iv = out.grid.v.indexOf(PEAK.v);
      expect(ih).toBeGreaterThanOrEqual(0);
      expect(iv).toBeGreaterThanOrEqual(0);
      // Type A (1.5, -0.6) is Type B (1.4999, -0.6002), so a little of the much lower neighbours
      // mixes in (~0.1% for this deliberately sharp spike). The coarsening bug lost ~5%.
      expect(Math.abs(out.values[iv * out.grid.h.length + ih]! / PEAK.cd - 1)).toBeLessThan(0.005);
    });

    it('still coarsens, and says so, when even the covered area is too large', () => {
      const out = resampleToTypeA({ type: 'B', h, v, values }, { maxPoints: 2000 })!;
      expect(out.coarsened).toBe(true);
      expect(out.grid.h.length * out.grid.v.length).toBeLessThanOrEqual(2000);
    });
  });

  it('coarsens the target step when the grid would exceed maxPoints, and says so', () => {
    const values = new Float64Array(4).fill(1);
    const out = resampleToTypeA({ type: 'C', h: [0, 360], v: [0, 180], values }, { step: 0.5, maxPoints: 10000 })!;
    expect(out.coarsened).toBe(true);
    expect(out.requestedStep).toBe(0.5);
    expect(out.grid.h.length * out.grid.v.length).toBeLessThanOrEqual(10000);
  });
});
