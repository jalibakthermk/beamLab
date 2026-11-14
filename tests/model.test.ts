import { describe, expect, it } from 'vitest';
import { createDataset, DatasetError, valueIndex } from '../core/model/dataset';
import { makeProvenance } from '../core/model/provenance';

const baseMeta = {
  keywords: [],
  lumens: null,
  multiplier: 1,
  ballastFactor: 1,
  ballastLampFactor: 1,
  watts: 0,
  dimensions: null,
  sourceType: 'A' as const,
  sourceFormat: 'synthetic' as const,
};

describe('PhotometricDataset model', () => {
  it('creates a dataset with default coverage equal to the grid bounds', () => {
    const ds = createDataset({
      id: 'x',
      name: 'x',
      kind: 'intensity',
      grid: { h: [-10, 0, 10], v: [-5, 5] },
      values: new Float64Array(6),
      meta: baseMeta,
      provenance: null,
    });
    expect(ds.coverage).toEqual({ hMin: -10, hMax: 10, vMin: -5, vMax: 5 });
  });

  it('stores values row-major [v][h]', () => {
    const grid = { h: [-10, 0, 10], v: [-5, 0, 5] };
    expect(valueIndex(grid, 0, 0)).toBe(0);
    expect(valueIndex(grid, 0, 2)).toBe(2); // first V row, last H
    expect(valueIndex(grid, 1, 0)).toBe(3); // second V row
    expect(valueIndex(grid, 2, 2)).toBe(8);
  });

  it('rejects non-ascending grids, wrong value counts and out-of-range angles', () => {
    const make = (h: number[], v: number[], n: number) => () =>
      createDataset({
        id: 'x',
        name: 'x',
        kind: 'intensity',
        grid: { h, v },
        values: new Float64Array(n),
        meta: baseMeta,
        provenance: null,
      });
    expect(make([0, 0, 1], [0], 3)).toThrow(DatasetError);
    expect(make([1, 0], [0], 2)).toThrow(DatasetError);
    expect(make([0, 1], [0], 3)).toThrow(DatasetError);
    expect(make([0, 181], [0], 2)).toThrow(DatasetError);
    expect(make([0], [-91, 0], 2)).toThrow(DatasetError);
    expect(make([], [0], 0)).toThrow(DatasetError);
  });

  it('records provenance with op, inputs, params and an ISO timestamp', () => {
    const p = makeProvenance('import', [], { flipH: false }, '2026-11-14T00:00:00.000Z');
    expect(p).toEqual({ op: 'import', inputs: [], params: { flipH: false }, timestamp: '2026-11-14T00:00:00.000Z' });
    expect(makeProvenance('x', [], {}).timestamp).toMatch(/^\d{4}-\d\d-\d\dT/);
  });
});
