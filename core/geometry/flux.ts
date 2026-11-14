import type { Grid, PhotometricDataset } from '../model/dataset';
import { ANGLE_EPS } from './interpolate';

/**
 * Luminous flux by integrating I over solid angle, dΩ = cos V · dV · dH (Type A).
 *
 * Each grid cell is integrated exactly for the bilinear interpolant of its
 * four corners: linear in H (trapezoid), and linear-in-V times cos V
 * integrated in closed form. For a cell [a, b] in V (radians, Δ = b − a):
 *   w_a = (cos a − cos b − Δ · sin a) / Δ      (weight of the row at a)
 *   w_b = (Δ · sin b + cos b − cos a) / Δ      (weight of the row at b)
 *   w_a + w_b = sin b − sin a
 * so a uniform intensity integrates exactly to I · ΔH · (sin Vmax − sin Vmin).
 */

const R = Math.PI / 180;

function vWeights(a: number, b: number): [number, number] {
  const ar = a * R;
  const br = b * R;
  const d = br - ar;
  const ca = Math.cos(ar);
  const cb = Math.cos(br);
  return [(ca - cb - d * Math.sin(ar)) / d, (d * Math.sin(br) + cb - ca) / d];
}

/**
 * Flux (lm for kind 'intensity') over the covered region. Cells with any NaN
 * corner, or outside the dataset's coverage, are skipped.
 */
export function flux(dataset: PhotometricDataset): number {
  const { h, v } = dataset.grid;
  const c = dataset.coverage;
  const nH = h.length;
  const vals = dataset.values;
  let total = 0;
  for (let iv = 0; iv + 1 < v.length; iv++) {
    const a = v[iv]!;
    const b = v[iv + 1]!;
    if (a < c.vMin - ANGLE_EPS || b > c.vMax + ANGLE_EPS) continue;
    const [wa, wb] = vWeights(a, b);
    for (let ih = 0; ih + 1 < nH; ih++) {
      const h0 = h[ih]!;
      const h1 = h[ih + 1]!;
      if (h0 < c.hMin - ANGLE_EPS || h1 > c.hMax + ANGLE_EPS) continue;
      const i00 = vals[iv * nH + ih]!;
      const i01 = vals[iv * nH + ih + 1]!;
      const i10 = vals[(iv + 1) * nH + ih]!;
      const i11 = vals[(iv + 1) * nH + ih + 1]!;
      const cell = ((h1 - h0) * R) / 2 * (wa * (i00 + i01) + wb * (i10 + i11));
      if (Number.isFinite(cell)) total += cell;
    }
  }
  return total;
}

/**
 * Per-node solid-angle weights (sr) for a fully covered grid, row-major [v][h]:
 * flux = Σ weights[i] · values[i]. Same integration rule as flux().
 */
export function solidAngleWeights(grid: Grid): Float64Array {
  const { h, v } = grid;
  const nH = h.length;
  const w = new Float64Array(nH * v.length);
  for (let iv = 0; iv + 1 < v.length; iv++) {
    const [wa, wb] = vWeights(v[iv]!, v[iv + 1]!);
    for (let ih = 0; ih + 1 < nH; ih++) {
      const half = ((h[ih + 1]! - h[ih]!) * R) / 2;
      w[iv * nH + ih] = w[iv * nH + ih]! + half * wa;
      w[iv * nH + ih + 1] = w[iv * nH + ih + 1]! + half * wa;
      w[(iv + 1) * nH + ih] = w[(iv + 1) * nH + ih]! + half * wb;
      w[(iv + 1) * nH + ih + 1] = w[(iv + 1) * nH + ih + 1]! + half * wb;
    }
  }
  return w;
}
