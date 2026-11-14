import { createDataset, type Coverage, type DatasetKind, type PhotometricDataset } from '../core/model/dataset';

/** Small synthetic dataset; f gives the value at (h, v). */
export function mk(
  h: number[],
  v: number[],
  f: (h: number, v: number) => number,
  opts: { kind?: DatasetKind; name?: string; coverage?: Coverage } = {},
): PhotometricDataset {
  const values = new Float64Array(h.length * v.length);
  v.forEach((vv, iv) => h.forEach((hh, ih) => (values[iv * h.length + ih] = f(hh, vv))));
  const name = opts.name ?? 'test';
  return createDataset({
    id: `id-${name}`,
    name,
    kind: opts.kind ?? 'intensity',
    grid: { h, v },
    values,
    ...(opts.coverage ? { coverage: opts.coverage } : {}),
    meta: {
      keywords: [], lumens: null, multiplier: 1, ballastFactor: 1, ballastLampFactor: 1,
      watts: 0, dimensions: null, sourceType: 'A', sourceFormat: 'synthetic',
    },
    provenance: null,
  });
}

/** Dataset from explicit row-major [v][h] values. */
export function mkRows(h: number[], v: number[], rows: number[][], opts: Parameters<typeof mk>[3] = {}) {
  return mk(h, v, (hh, vv) => rows[v.indexOf(vv)]![h.indexOf(hh)]!, opts);
}
