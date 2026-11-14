import { describe, expect, it } from 'vitest';
import {
  add,
  clampToIntensity,
  divide,
  multiply,
  OperationError,
  planBinary,
  scale,
  subtract,
  windowMask,
  negativeCount,
} from '../core/ops/arithmetic';
import { valuesOnGrid } from '../core/geometry/resample';
import { resample } from '../core/geometry/resample';
import { flux } from '../core/geometry/flux';
import { exportIes, ExportError } from '../core/io/export';
import { mk, mkRows } from './helpers';

const G = { h: [0, 1], v: [0, 1] };
const A = mkRows(G.h, G.v, [[1, 2], [3, 4]], { name: 'A.ies' });
const B = mkRows(G.h, G.v, [[10, 20], [30, 40]], { name: 'B.ies' });
const vals = (d: { values: Float64Array }) => Array.from(d.values);

function expectOpError(fn: () => unknown, code: string, text?: RegExp) {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(OperationError);
    expect((e as OperationError).code).toBe(code);
    if (text) expect((e as Error).message).toMatch(text);
    return;
  }
  throw new Error(`expected OperationError ${code}`);
}

describe('hand-calculated cases on a 2 × 2 grid', () => {
  it('add: A + B, intensity + intensity = intensity', () => {
    const r = add(A, B);
    expect(vals(r)).toEqual([11, 22, 33, 44]);
    expect(r.kind).toBe('intensity');
  });

  it('add with weights: 2·A + 0.5·B', () => {
    expect(vals(add(A, B, { weights: [2, 0.5] }))).toEqual([7, 14, 21, 28]);
  });

  it('add with a negative weight gives a difference', () => {
    const r = add(A, B, { weights: [1, -1] });
    expect(r.kind).toBe('difference');
    expect(vals(r)).toEqual([-9, -18, -27, -36]);
  });

  it('subtract: A − B gives a signed difference; negatives are kept', () => {
    const r = subtract(A, B);
    expect(r.kind).toBe('difference');
    expect(vals(r)).toEqual([-9, -18, -27, -36]);
  });

  it('scale: A × 2.5 stays intensity; negative k is rejected', () => {
    const r = scale(A, 2.5);
    expect(vals(r)).toEqual([2.5, 5, 7.5, 10]);
    expect(r.kind).toBe('intensity');
    expectOpError(() => scale(A, -1), 'BAD_SCALE', /negative/i);
    expectOpError(() => scale(A, NaN), 'BAD_SCALE');
  });

  it('multiply by a mask or a ratio map', () => {
    const M = mkRows(G.h, G.v, [[1, 0], [0, 1]], { kind: 'mask', name: 'M' });
    const R = mkRows(G.h, G.v, [[0.5, 1], [2, 1]], { kind: 'ratio', name: 'R' });
    expect(vals(multiply(A, M))).toEqual([1, 0, 0, 4]);
    expect(multiply(A, M).kind).toBe('intensity');
    expect(vals(multiply(A, R))).toEqual([0.5, 2, 6, 4]);
  });

  it('multiply rejects intensity × intensity with a clear error', () => {
    expectOpError(() => multiply(A, B), 'KIND', /ratio or a mask/);
  });

  it('divide: B / A gives a ratio; below the denominator floor the result is NaN', () => {
    const r = divide(B, A, { floor: 2.5 });
    expect(r.kind).toBe('ratio');
    expect(vals(r)).toEqual([NaN, NaN, 10, 10]);
    expect(r.provenance?.params['floor']).toBe(2.5);
  });

  it('divide: default floor is 0.1% of the denominator peak', () => {
    const r = divide(B, A);
    expect(vals(r)).toEqual([10, 10, 10, 10]);
    expect(r.provenance?.params['floor']).toBeCloseTo(0.004, 12);
    expect(r.provenance?.params['floorIsDefault']).toBe(true);
    expectOpError(() => divide(B, A, { floor: -1 }), 'BAD_FLOOR');
  });

  it('clampToIntensity sets negatives to zero and records how many', () => {
    const D = subtract(A, mkRows(G.h, G.v, [[2, 1], [1, 5]], { name: 'C' }));
    expect(vals(D)).toEqual([-1, 1, 2, -1]);
    const c = clampToIntensity(D);
    expect(c.kind).toBe('intensity');
    expect(vals(c)).toEqual([0, 1, 2, 0]);
    expect(c.provenance?.params['clampedNodes']).toBe(2);
    expect(negativeCount(D)).toBe(2);
    expectOpError(() => clampToIntensity(A), 'KIND', /difference/);
  });

  it('windowMask: 1 inside the window, 0 outside', () => {
    const m = windowMask({ h: [0, 1, 2], v: [0, 1] }, { hMin: 0.5, hMax: 2, vMin: 0, vMax: 0.5 });
    expect(m.kind).toBe('mask');
    expect(vals(m)).toEqual([0, 1, 1, 0, 0, 0]);
    expectOpError(() => windowMask(G, { hMin: 1, hMax: 0, vMin: 0, vMax: 1 }), 'BAD_WINDOW');
  });

  it('NaN in any input gives NaN in the result', () => {
    const N = mkRows(G.h, G.v, [[NaN, 1], [1, 1]], { name: 'N' });
    const M0 = mkRows(G.h, G.v, [[0, 0], [0, 0]], { kind: 'mask', name: 'zero mask' });
    expect(vals(add(A, N))[0]).toBeNaN();
    expect(vals(subtract(N, A))[0]).toBeNaN();
    expect(vals(multiply(N, M0))[0]).toBeNaN();
    expect(vals(divide(N, A))[0]).toBeNaN();
    expect(vals(scale(N, 2))[0]).toBeNaN();
  });

  it('never modifies the inputs', () => {
    const before = [vals(A), vals(B)];
    add(A, B);
    subtract(A, B);
    scale(A, 3);
    divide(A, B);
    expect([vals(A), vals(B)]).toEqual(before);
  });
});

describe('kind rules and export', () => {
  const D = subtract(A, B);
  const R = divide(A, B);
  const M = windowMask(G, { hMin: 0, hMax: 1, vMin: 0, vMax: 0 });

  it('ratio and mask inputs cannot be added or subtracted', () => {
    expectOpError(() => add(A, R), 'KIND');
    expectOpError(() => subtract(M, A), 'KIND');
  });

  it('difference + intensity gives a difference', () => {
    expect(add(D, B).kind).toBe('difference');
  });

  it('only intensity can be exported as IES', () => {
    for (const d of [D, R, M]) {
      expect(() => exportIes(d)).toThrow(ExportError);
    }
    expect(() => exportIes(add(A, B))).not.toThrow();
    expect(() => exportIes(clampToIntensity(subtract(B, A)))).not.toThrow();
  });
});

describe('different grids and coverages', () => {
  // A: linear in H on a coarse grid; B: constant on a finer, shifted grid
  const A2 = mk([0, 2, 4], [0, 1], (h) => 10 * h, { name: 'A2' });
  const B2 = mk([1, 1.5, 2, 2.5, 3, 5], [0, 1], () => 5, { name: 'B2' });

  it('intersection: merged nodes, values sampled exactly from each input', () => {
    const r = add(A2, B2);
    expect(r.grid.h).toEqual([1, 1.5, 2, 2.5, 3, 4]);
    expect(vals(r).slice(0, 6)).toEqual([15, 20, 25, 30, 35, 45]);
    expect(r.coverage).toEqual({ hMin: 1, hMax: 4, vMin: 0, vMax: 1 });
    expect(r.provenance?.params['resampled']).toBe(true);
  });

  it('union: NaN where only one input has data', () => {
    const r = add(A2, B2, { extent: 'union' });
    expect(r.grid.h).toEqual([0, 1, 1.5, 2, 2.5, 3, 4, 5]);
    const row = vals(r).slice(0, 8);
    expect(row[0]).toBeNaN(); // only A2 at H 0
    expect(row[1]).toBe(15);
    expect(row[7]).toBeNaN(); // only B2 at H 5
  });

  it('union with "treat outside coverage as zero" for both inputs', () => {
    const r = add(A2, B2, { extent: 'union', zeroOutside: { a: true, b: true } });
    expect(vals(r).slice(0, 8)).toEqual([0, 15, 20, 25, 30, 35, 45, 5]);
    expect(r.provenance?.params['zeroOutside']).toEqual({ a: true, b: true });
  });

  it('identical grids: node by node, no resampling recorded', () => {
    expect(add(A, B).provenance?.params['resampled']).toBe(false);
  });

  it('planBinary describes the grid before running, and reports errors', () => {
    expect(planBinary('add', A, B)).toMatchObject({ ok: true, identical: true, gridSize: { h: 2, v: 2 }, resultKind: 'intensity' });
    expect(planBinary('subtract', A2, B2)).toMatchObject({ ok: true, identical: false, gridSize: { h: 6, v: 2 }, resultKind: 'difference' });
    const far = mk([20, 21], [0, 1], () => 1);
    expect(planBinary('add', A2, far)).toMatchObject({ ok: false });
    expect(planBinary('multiply', A, B)).toMatchObject({ ok: false });
  });
});

describe('invariants', () => {
  const f = (h: number, v: number) => 1000 + 37.3 * h - 11.7 * v + 0.37 * h * v;
  const g = (h: number, v: number) => 500 + 13.1 * h * h + 7.9 * v;
  const Ga = { h: [-10, -6, -3, 0, 3, 6, 10], v: [-5, -2, 0, 2, 5] };
  const Gb = { h: [-6, -4.5, -2, 0.5, 2, 4.5, 6], v: [-4, -1.5, 1, 4] };
  const P = mk(Ga.h, Ga.v, f, { name: 'P' });
  const Q = mk(Ga.h, Ga.v, g, { name: 'Q' });
  const Qb = mk(Gb.h, Gb.v, g, { name: 'Qb' });
  const rel = (x: number, y: number) => Math.abs(x - y) / Math.max(1, Math.abs(y));

  it('A + B − B = A on identical grids (to floating-point rounding, 1e-12 relative)', () => {
    const r = subtract(add(P, Q), Q);
    vals(r).forEach((x, i) => expect(rel(x, P.values[i]!)).toBeLessThan(1e-12));
  });

  it('A + B − B = A on different grids, compared on the merged grid (1e-9 relative)', () => {
    const r = subtract(add(P, Qb), Qb);
    const ref = valuesOnGrid(P, r.grid);
    vals(r).forEach((x, i) => {
      if (Number.isNaN(ref[i]!)) expect(x).toBeNaN();
      else expect(rel(x, ref[i]!)).toBeLessThan(1e-9);
    });
  });

  it('scale(A, k) then scale by 1/k returns A (1e-12 relative)', () => {
    const r = scale(scale(P, 7.3), 1 / 7.3);
    vals(r).forEach((x, i) => expect(rel(x, P.values[i]!)).toBeLessThan(1e-12));
  });

  it('divide(A, A) is exactly 1 wherever A is above the floor, NaN below', () => {
    const W = mk(Ga.h, Ga.v, (h) => (h < 0 ? 0.5 : 100 + h));
    const r = divide(W, W, { floor: 1 });
    vals(r).forEach((x, i) => (W.values[i]! >= 1 ? expect(x).toBe(1) : expect(x).toBeNaN()));
  });

  it('divide(A, A on a finer grid containing A’s nodes) is 1 (1e-12): the grids differ but the surfaces agree', () => {
    const fine = { h: [-10, -8, -6, -4.5, -3, -1, 0, 1.5, 3, 4, 6, 8, 10], v: [-5, -3.5, -2, -1, 0, 1, 2, 3, 5] };
    const Pf = resample(P, fine);
    const r = divide(P, Pf);
    vals(r).forEach((x) => expect(Math.abs(x - 1)).toBeLessThan(1e-12));
  });

  it('flux(A + B) = flux(A) + flux(B) on the same coverage (identical and different grids)', () => {
    expect(rel(flux(add(P, Q)), flux(P) + flux(Q))).toBeLessThan(1e-12);
    // Different grids: compare on the intersection (H -6..6, V -4..4), whose edges are nodes of both
    const box = { hMin: -6, hMax: 6, vMin: -4, vMax: 4 };
    const Pb = mk(Ga.h.concat([-4.5, -2, 0.5, 2, 4.5]).sort((a, b) => a - b), [-5, -4, -2, -1.5, 0, 1, 2, 4, 5], f, { name: 'Pb' });
    const sum = add(Pb, Qb);
    const restricted = (d: typeof Pb) => flux({ ...d, coverage: box });
    expect(rel(flux(sum), restricted(Pb) + restricted(Qb))).toBeLessThan(1e-9);
  });
});
