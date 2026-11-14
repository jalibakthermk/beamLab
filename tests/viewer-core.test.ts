import { describe, expect, it } from 'vitest';
import { hSection, vSection } from '../core/analysis/section';
import { autoLevels, decadeTicks, displayScaleFor, divergingRange, levelsForKind, logFloor, niceStep, parseLevels, ratioLogRange, valueRange } from '../core/analysis/levels';
import { displayGrid, strideIndices, toDisplay } from '../core/analysis/display';
import { createDataset, type PhotometricDataset } from '../core/model/dataset';
import { parseIes } from '../core/io/ies';
import { GAUSS, gaussCd } from './fixtures/generate';
import { fixture } from './load-fixture';

function ds(h: number[], v: number[], f: (h: number, v: number) => number, coverage?: PhotometricDataset['coverage']) {
  const values = new Float64Array(h.length * v.length);
  v.forEach((vv, iv) => h.forEach((hh, ih) => (values[iv * h.length + ih] = f(hh, vv))));
  return createDataset({
    id: 't',
    name: 't',
    kind: 'intensity',
    grid: { h, v },
    values,
    ...(coverage ? { coverage } : {}),
    meta: {
      keywords: [], lumens: null, multiplier: 1, ballastFactor: 1, ballastLampFactor: 1,
      watts: 0, dimensions: null, sourceType: 'A', sourceFormat: 'synthetic',
    },
    provenance: null,
  });
}

describe('sections (core/analysis/section)', () => {
  const plane = ds([-10, 0, 10], [-5, 0, 5], (h, v) => 100 + 2 * h + 3 * v);

  it('H section at any V: intensity at every grid H, from full-resolution data', () => {
    const s = hSection(plane, 2.5);
    expect(s.axis).toBe('H');
    expect(s.at).toBe(2.5);
    expect(s.angles).toEqual([-10, 0, 10]);
    expect(s.values.map((x) => Number(x.toFixed(9)))).toEqual([87.5, 107.5, 127.5]);
  });

  it('V section at any H: intensity at every grid V', () => {
    const s = vSection(plane, -5);
    expect(s.axis).toBe('V');
    expect(s.angles).toEqual([-5, 0, 5]);
    expect(s.values).toEqual([75, 90, 105]);
  });

  it('is NaN outside coverage, never zero', () => {
    expect(hSection(plane, 6).values.every(Number.isNaN)).toBe(true);
    const narrow = ds([-10, 0, 10], [-5, 0, 5], () => 1, { hMin: -10, hMax: 0, vMin: -5, vMax: 5 });
    expect(hSection(narrow, 0).values).toEqual([1, 1, NaN]);
  });

  it('passes through the Gaussian peak at its known position', () => {
    const g = parseIes(fixture('gaussian-spot-typeA.ies')).dataset;
    const s = hSection(g, GAUSS.v0);
    const i = s.values.indexOf(Math.max(...s.values));
    expect(s.angles[i]).toBe(GAUSS.h0);
    expect(s.values[i]).toBe(GAUSS.peak);
    const t = vSection(g, GAUSS.h0);
    expect(t.angles[t.values.indexOf(Math.max(...t.values))]).toBe(GAUSS.v0);
    expect(t.values[t.angles.indexOf(-2)]).toBeCloseTo(gaussCd(GAUSS.h0, -2), 2);
  });
});

describe('contour levels (core/analysis/levels)', () => {
  it('niceStep rounds up to 1, 2, 2.5 or 5 × 10^k', () => {
    expect(niceStep(1800)).toBe(2000);
    expect(niceStep(2100)).toBe(2500);
    expect(niceStep(0.03)).toBe(0.05);
    expect(niceStep(700)).toBe(1000);
    expect(niceStep(100)).toBe(100);
  });

  it('linear auto levels are nice multiples up to the maximum, excluding 0', () => {
    expect(autoLevels(20000, 'linear')).toEqual([2000, 4000, 6000, 8000, 10000, 12000, 14000, 16000, 18000, 20000]);
    expect(autoLevels(950, 'linear', { count: 5 })).toEqual([200, 400, 600, 800]);
  });

  it('log auto levels are 1-2-5 per decade between min and max', () => {
    expect(autoLevels(20000, 'log', { min: 20 })).toEqual([20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]);
    // default range: three decades below the maximum
    expect(autoLevels(1000, 'log')).toEqual([1, 2, 5, 10, 20, 50, 100, 200, 500, 1000]);
  });

  it('returns no levels for an empty or non-positive maximum', () => {
    expect(autoLevels(NaN, 'linear')).toEqual([]);
    expect(autoLevels(0, 'log')).toEqual([]);
  });

  it('parses a user list in cd, sorted and de-duplicated, reporting invalid entries', () => {
    expect(parseLevels('1000, 100 500;2e3  500')).toEqual({ levels: [100, 500, 1000, 2000], invalid: [] });
    expect(parseLevels('100, abc, -5, 0, 300')).toEqual({ levels: [100, 300], invalid: ['abc', '-5', '0'] });
    expect(parseLevels('   ')).toEqual({ levels: [], invalid: [] });
  });

  it('log display floor sits below the smallest positive value', () => {
    expect(logFloor([0, 5, 100, NaN, -3])).toBe(0.5);
    expect(logFloor([0, NaN])).toBe(1e-3);
  });

  it('decade ticks cover the range', () => {
    expect(decadeTicks(3, 25000)).toEqual([10, 100, 1000, 10000]);
    expect(decadeTicks(0.5, 2)).toEqual([1]);
  });
});

describe('display grid (core/analysis/display)', () => {
  it('stride indices always keep the first and last index', () => {
    expect(strideIndices(5, 10)).toEqual([0, 1, 2, 3, 4]);
    expect(strideIndices(10, 4)).toEqual([0, 3, 6, 9]);
    expect(strideIndices(11, 4)).toEqual([0, 3, 6, 9, 10]);
  });

  it('linear: z rows follow V ascending, NaN becomes null (empty), not zero', () => {
    const d = displayGrid(ds([0, 1], [0, 1], (h, v) => (h === 1 && v === 1 ? NaN : 10 * h + v)), { scale: 'linear' });
    expect(d.z).toEqual([[0, 10], [1, null]]);
    expect(d.downsampled).toBe(false);
    expect(d.floor).toBeNull();
    expect([d.zmin, d.zmax]).toEqual([0, 10]);
  });

  it('log: zero is floored for display only, values become log10', () => {
    const d = displayGrid(ds([0, 1], [0], (h) => (h === 0 ? 0 : 100)), { scale: 'log' });
    expect(d.floor).toBe(10);
    expect(d.z).toEqual([[1, 2]]);
    expect(toDisplay(NaN, 'log', 10)).toBeNull();
    expect(toDisplay(1000, 'log', 10)).toBe(3);
  });

  it('downsamples fine grids for display and says so; the dataset itself is untouched', () => {
    const h = Array.from({ length: 1201 }, (_, i) => -60 + i * 0.1);
    const g = ds(h, [0, 1], (hh) => hh);
    const d = displayGrid(g, { scale: 'linear', maxPerAxis: 500 });
    expect(d.downsampled).toBe(true);
    expect(d.stride.h).toBe(3);
    expect(d.h.length).toBeLessThanOrEqual(501);
    expect(d.h[0]).toBe(-60);
    expect(d.h.at(-1)).toBeCloseTo(60, 9);
    expect(g.values.length).toBe(2402);
  });
});

describe('display rules per dataset kind (core/analysis/levels)', () => {
  it('valueRange: min, max, largest magnitude and smallest positive, ignoring NaN', () => {
    expect(valueRange([-30, 0, NaN, 5, 0.2])).toEqual({ min: -30, max: 5, maxAbs: 30, minPositive: 0.2 });
    expect(valueRange([NaN])).toEqual({ min: NaN, max: NaN, maxAbs: NaN, minPositive: NaN });
  });

  it('display scale: difference and mask always linear, ratio always log, intensity as chosen', () => {
    expect(displayScaleFor('intensity', 'log')).toBe('log');
    expect(displayScaleFor('difference', 'log')).toBe('linear');
    expect(displayScaleFor('mask', 'log')).toBe('linear');
    expect(displayScaleFor('ratio', 'linear')).toBe('log');
  });

  it('difference levels are symmetric about zero and include the zero contour', () => {
    expect(levelsForKind('difference', valueRange([-1000, 950]), 'linear')).toEqual([-1000, -800, -600, -400, -200, 0, 200, 400, 600, 800]);
  });

  it('ratio levels are fixed multiplicative steps within the data range, including 1', () => {
    expect(levelsForKind('ratio', valueRange([0.6, 1, 3]), 'log')).toEqual([0.8, 0.9, 1, 1.1, 1.25, 2]);
  });

  it('mask has one boundary level at 0.5; intensity uses the automatic levels', () => {
    expect(levelsForKind('mask', valueRange([0, 1]), 'linear')).toEqual([0.5]);
    expect(levelsForKind('intensity', valueRange([0, 20000]), 'linear')).toEqual(autoLevels(20000, 'linear'));
  });

  it('colour ranges: diverging centred on zero; ratio centred on 1 in log10, capped at ×100', () => {
    expect(divergingRange(valueRange([-200, 50]))).toEqual({ zmin: -200, zmax: 200 });
    expect(ratioLogRange(valueRange([0.5, 4]))).toEqual({ zmin: -Math.log10(4), zmax: Math.log10(4) });
    expect(ratioLogRange(valueRange([1e-5, 1]))).toEqual({ zmin: -2, zmax: 2 });
  });
});
