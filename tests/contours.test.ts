import { describe, expect, it } from 'vitest';
import { contourLines, toLineXY } from '../core/analysis/contours';
import { displayGrid } from '../core/analysis/display';
import { parseIes } from '../core/io/ies';
import { range } from './fixtures/generate';
import { fixture } from './load-fixture';

type Z = (number | null)[][];
const matrix = (h: number[], v: number[], f: (h: number, v: number) => number | null): Z => v.map((vv) => h.map((hh) => f(hh, vv)));

describe('contour lines (marching squares, core/analysis/contours)', () => {
  it('a plane gives one straight line at the interpolated position', () => {
    const h = [0, 1, 2];
    const v = [0, 1, 2];
    const lines = contourLines(h, v, matrix(h, v, (x) => x), 0.5);
    expect(lines).toHaveLength(1);
    const l = lines[0]!;
    expect(l.x.every((x) => Math.abs(x - 0.5) < 1e-12)).toBe(true);
    expect(Math.min(...l.y)).toBe(0);
    expect(Math.max(...l.y)).toBe(2);
    expect(l.x).toHaveLength(3); // joined into one polyline, not separate segments
  });

  it('a paraboloid gives one closed ring at radius 1', () => {
    const h = range(-2, 2, 0.05);
    const v = range(-2, 2, 0.05);
    const lines = contourLines(h, v, matrix(h, v, (x, y) => x * x + y * y), 1);
    expect(lines).toHaveLength(1);
    const ring = lines[0]!;
    expect(ring.closed).toBe(true);
    expect(ring.x[0]).toBe(ring.x.at(-1));
    expect(ring.y[0]).toBe(ring.y.at(-1));
    for (let i = 0; i < ring.x.length; i++) expect(Math.abs(Math.hypot(ring.x[i]!, ring.y[i]!) - 1)).toBeLessThan(0.002);
  });

  it('skips cells without data: no line enters an empty region', () => {
    const h = range(-2, 2, 0.1);
    const v = range(-2, 2, 0.1);
    // right half has no data
    const lines = contourLines(h, v, matrix(h, v, (x, y) => (x > 0.5 ? null : x * x + y * y)), 1);
    const pts = lines.flatMap((l) => l.x);
    expect(pts.length).toBeGreaterThan(0);
    expect(Math.max(...pts)).toBeLessThanOrEqual(0.5 + 1e-12);
    expect(lines.every((l) => !l.closed)).toBe(true); // the ring is cut open at the data edge
  });

  it('returns nothing when the level is not crossed, or all data is missing', () => {
    const h = [0, 1];
    const v = [0, 1];
    expect(contourLines(h, v, matrix(h, v, () => 5), 10)).toEqual([]);
    expect(contourLines(h, v, matrix(h, v, () => 5), 5)).toEqual([]); // equal counts as above
    expect(contourLines(h, v, matrix(h, v, () => null), 1)).toEqual([]);
  });

  it('resolves a saddle cell into two separate lines that do not cross', () => {
    const h = [0, 1];
    const v = [0, 1];
    const z: Z = [
      [1, 0],
      [0, 1],
    ];
    const lines = contourLines(h, v, z, 0.5);
    expect(lines).toHaveLength(2);
    for (const l of lines) expect(l.x).toHaveLength(2);
  });

  it('works on non-uniform grids', () => {
    const h = [0, 0.1, 0.5, 2];
    const v = [0, 1];
    const lines = contourLines(h, v, matrix(h, v, (x) => x), 1);
    expect(lines[0]!.x.every((x) => Math.abs(x - 1) < 1e-12)).toBe(true);
  });

  it('toLineXY joins polylines for one plot trace, separated by nulls', () => {
    const xy = toLineXY([
      { x: [0, 1], y: [0, 1], closed: false },
      { x: [2, 3], y: [2, 3], closed: false },
    ]);
    expect(xy).toEqual({ x: [0, 1, null, 2, 3], y: [0, 1, null, 2, 3] });
  });

  it('asymmetric fixture: the 3000 cd contour surrounds the hot spot, right (+H) and up (+V)', () => {
    const ds = parseIes(fixture('asymmetric-typeA.ies')).dataset;
    const g = displayGrid(ds, { scale: 'linear' });
    const lines = contourLines(g.h, g.v, g.z, 3000);
    expect(lines).toHaveLength(1);
    const l = lines[0]!;
    const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
    expect(mean(l.x)).toBeCloseTo(20, 0);
    expect(mean(l.y)).toBeCloseTo(5, 0);
  });

  it('is fast on a display grid with large empty areas (the case Plotly was slow on)', () => {
    const h = range(-90, 90, 0.4);
    const v = range(-40, 40, 0.2);
    const z = matrix(h, v, (x, y) => (Math.abs(x) + Math.abs(y) * 2 > 100 ? null : 30000 * Math.exp(-(x * x) / 200 - (y * y) / 8)));
    const t0 = performance.now();
    for (const level of [1000, 2000, 5000, 10000, 15000, 20000, 25000]) contourLines(h, v, z, level);
    expect(performance.now() - t0).toBeLessThan(1000);
  });
});
