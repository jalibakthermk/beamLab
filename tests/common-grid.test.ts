import { describe, expect, it } from 'vitest';
import { commonGrid, GridError, mergeAxes, valuesOnGrid } from '../core/geometry/resample';
import { mk, mkRows } from './helpers';

function expectGridError(fn: () => unknown, code: string) {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(GridError);
    expect((e as GridError).code).toBe(code);
    expect((e as GridError).message.length).toBeGreaterThan(20);
    return;
  }
  throw new Error(`expected GridError ${code}`);
}

describe('mergeAxes', () => {
  it('merges both node sets within the extent, dropping nodes closer than the tolerance', () => {
    expect(mergeAxes([0, 1, 2, 3, 4], [1, 1.5, 2.0000000004, 2.5, 3], 1, 3, 1e-6)).toEqual([1, 1.5, 2, 2.5, 3]);
    expect(mergeAxes([0, 2], [1, 3], 0, 3, 1e-6)).toEqual([0, 1, 2, 3]);
  });
  it('adds the extent limits as nodes', () => {
    expect(mergeAxes([0, 2, 4], [1, 3, 5], 1, 4, 1e-6)).toEqual([1, 2, 3, 4]);
    expect(mergeAxes([0, 4], [0, 4], 0.5, 3.5, 1e-6)).toEqual([0.5, 3.5]);
  });
});

describe('commonGrid', () => {
  const A = mk([0, 1, 2, 3, 4], [-1, 0, 1], () => 1, { name: 'A' });

  it('identical grids: no resampling, grid unchanged', () => {
    const B = mk([0, 1, 2, 3, 4], [-1, 0, 1], () => 2, { name: 'B' });
    const g = commonGrid(A, B);
    expect(g.identical).toBe(true);
    expect(g.grid).toEqual(A.grid);
    expect(g.coverage).toEqual({ hMin: 0, hMax: 4, vMin: -1, vMax: 1 });
  });

  it('identical grids but narrower coverage: grid kept, coverage intersected', () => {
    const B = mk([0, 1, 2, 3, 4], [-1, 0, 1], () => 2, { coverage: { hMin: 1, hMax: 3, vMin: -1, vMax: 1 } });
    const g = commonGrid(A, B);
    expect(g.identical).toBe(true);
    expect(g.coverage).toEqual({ hMin: 1, hMax: 3, vMin: -1, vMax: 1 });
    expect(commonGrid(A, B, { extent: 'union' }).coverage).toEqual({ hMin: 0, hMax: 4, vMin: -1, vMax: 1 });
  });

  it('different grids: merged nodes of both inputs, so neither loses resolution', () => {
    const B = mk([1, 1.5, 2, 2.5, 3, 5], [-0.5, 0, 0.5, 2], () => 2);
    const inter = commonGrid(A, B);
    expect(inter.identical).toBe(false);
    expect(inter.grid.h).toEqual([1, 1.5, 2, 2.5, 3, 4, 5].filter((x) => x <= 4));
    expect(inter.grid.v).toEqual([-0.5, 0, 0.5, 1]);
    expect(inter.coverage).toEqual({ hMin: 1, hMax: 4, vMin: -0.5, vMax: 1 });
    const union = commonGrid(A, B, { extent: 'union' });
    expect(union.grid.h).toEqual([0, 1, 1.5, 2, 2.5, 3, 4, 5]);
    expect(union.grid.v).toEqual([-1, -0.5, 0, 0.5, 1, 2]);
  });

  it('stops with a clear error when coverages do not overlap', () => {
    const B = mk([10, 11], [0, 1], () => 1);
    expectGridError(() => commonGrid(A, B), 'NO_OVERLAP');
    expect(commonGrid(A, B, { extent: 'union' }).grid.h).toEqual([0, 1, 2, 3, 4, 10, 11]);
  });

  it('stops with a clear error instead of building a huge grid', () => {
    const B = mk([0.5, 1.5, 2.5, 3.5], [-0.5, 0.5], () => 1);
    expectGridError(() => commonGrid(A, B, { maxPoints: 20 }), 'GRID_TOO_LARGE');
  });
});

describe('valuesOnGrid', () => {
  const A = mkRows([0, 2], [0, 1], [
    [0, 20],
    [10, 30],
  ]);

  it('samples at merged nodes; existing nodes keep their exact values', () => {
    const vals = valuesOnGrid(A, { h: [0, 1, 2], v: [0, 1] });
    expect(Array.from(vals)).toEqual([0, 10, 20, 10, 20, 30]);
  });

  it('is NaN outside the input coverage, or 0 with zeroOutside', () => {
    const grid = { h: [0, 2, 4], v: [0, 1] };
    expect(Array.from(valuesOnGrid(A, grid))).toEqual([0, 20, NaN, 10, 30, NaN]);
    expect(Array.from(valuesOnGrid(A, grid, { zeroOutside: true }))).toEqual([0, 20, 0, 10, 30, 0]);
  });

  it('on its own grid, masks nodes outside a narrowed coverage', () => {
    const narrowed = { ...A, coverage: { hMin: 0, hMax: 0, vMin: 0, vMax: 1 } };
    expect(Array.from(valuesOnGrid(narrowed, A.grid))).toEqual([0, NaN, 10, NaN]);
  });
});
