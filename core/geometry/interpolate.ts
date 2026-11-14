import type { PhotometricDataset } from '../model/dataset';

/** Angular tolerance (degrees) for rounding noise at axis ends. */
export const ANGLE_EPS = 1e-9;

export interface Bracket {
  i0: number;
  i1: number;
  /** Fraction between axis[i0] (t = 0) and axis[i1] (t = 1). */
  t: number;
}

/** Locates x on an ascending axis. Returns null outside [first, last] (± ANGLE_EPS). */
export function bracket(axis: ArrayLike<number>, x: number): Bracket | null {
  const n = axis.length;
  if (n === 0 || !Number.isFinite(x)) return null;
  const first = axis[0]!;
  const last = axis[n - 1]!;
  if (x < first - ANGLE_EPS || x > last + ANGLE_EPS) return null;
  if (n === 1) return { i0: 0, i1: 0, t: 0 };
  if (x <= first) return { i0: 0, i1: 1, t: 0 };
  if (x >= last) return { i0: n - 2, i1: n - 1, t: 1 };
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (axis[mid]! <= x) lo = mid;
    else hi = mid;
  }
  const a = axis[lo]!;
  return { i0: lo, i1: lo + 1, t: (x - a) / (axis[lo + 1]! - a) };
}

/**
 * Bilinear interpolation on a row-major [v][h] array.
 * Corners with zero weight are ignored, so nodes next to NaN still return
 * their exact value. Any contributing NaN corner gives NaN.
 */
export function bilinear(
  hAxis: ArrayLike<number>,
  vAxis: ArrayLike<number>,
  values: ArrayLike<number>,
  h: number,
  v: number,
): number {
  const bh = bracket(hAxis, h);
  const bv = bracket(vAxis, v);
  if (!bh || !bv) return NaN;
  const nH = hAxis.length;
  let sum = 0;
  const corners: Array<[number, number, number]> = [
    [bv.i0, bh.i0, (1 - bv.t) * (1 - bh.t)],
    [bv.i0, bh.i1, (1 - bv.t) * bh.t],
    [bv.i1, bh.i0, bv.t * (1 - bh.t)],
    [bv.i1, bh.i1, bv.t * bh.t],
  ];
  for (const [iv, ih, w] of corners) {
    if (w === 0) continue;
    const val = values[iv * nH + ih]!;
    if (!Number.isFinite(val)) return NaN;
    sum += w * val;
  }
  return sum;
}

export type InterpolationMethod = 'bilinear';

/** Value of a canonical dataset at (h, v) degrees. NaN outside coverage. */
export function sample(
  dataset: PhotometricDataset,
  h: number,
  v: number,
  method: InterpolationMethod = 'bilinear',
): number {
  if (method !== 'bilinear') throw new Error(`interpolation method not implemented: ${String(method)}`);
  const c = dataset.coverage;
  if (h < c.hMin - ANGLE_EPS || h > c.hMax + ANGLE_EPS || v < c.vMin - ANGLE_EPS || v > c.vMax + ANGLE_EPS) {
    return NaN;
  }
  return bilinear(dataset.grid.h, dataset.grid.v, dataset.values, h, v);
}
