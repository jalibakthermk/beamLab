import type { PhotometricDataset } from '../model/dataset';
import { logFloor, type IntensityScale } from './levels';

/**
 * Display-only matrix for plotting. Downsamples very fine grids by taking
 * every n-th grid line (first and last always kept). Never used for read-outs
 * or sections, which always use the full data.
 */
export interface DisplayGrid {
  h: number[];
  v: number[];
  /** z[iv][ih] in display units (cd, or log10 cd); null where there is no data. */
  z: (number | null)[][];
  stride: { h: number; v: number };
  downsampled: boolean;
  /** Log scale only: value (cd) shown in place of values ≤ 0. */
  floor: number | null;
  /** Range of z in display units. */
  zmin: number;
  zmax: number;
}

export function strideIndices(n: number, maxPoints: number): number[] {
  const s = Math.max(1, Math.ceil(n / maxPoints));
  const out: number[] = [];
  for (let i = 0; i < n; i += s) out.push(i);
  if (out[out.length - 1] !== n - 1) out.push(n - 1);
  return out;
}

export function toDisplay(x: number, scale: IntensityScale, floor: number | null): number | null {
  if (!Number.isFinite(x)) return null;
  if (scale === 'linear') return x;
  return Math.log10(x > 0 ? x : (floor ?? 1e-3));
}

export function displayGrid(
  dataset: PhotometricDataset,
  options: { scale: IntensityScale; maxPerAxis?: number },
): DisplayGrid {
  const max = options.maxPerAxis ?? 500;
  const { h, v } = dataset.grid;
  const ih = strideIndices(h.length, max);
  const iv = strideIndices(v.length, max);
  const floor = options.scale === 'log' ? logFloor(dataset.values) : null;
  let zmin = Infinity;
  let zmax = -Infinity;
  const z = iv.map((r) =>
    ih.map((c) => {
      const d = toDisplay(dataset.values[r * h.length + c]!, options.scale, floor);
      if (d !== null) {
        if (d < zmin) zmin = d;
        if (d > zmax) zmax = d;
      }
      return d;
    }),
  );
  const sh = Math.max(1, Math.ceil(h.length / max));
  const sv = Math.max(1, Math.ceil(v.length / max));
  return {
    h: ih.map((i) => h[i]!),
    v: iv.map((i) => v[i]!),
    z,
    stride: { h: sh, v: sv },
    downsampled: sh > 1 || sv > 1,
    floor,
    zmin: Number.isFinite(zmin) ? zmin : 0,
    zmax: Number.isFinite(zmax) ? zmax : 1,
  };
}
