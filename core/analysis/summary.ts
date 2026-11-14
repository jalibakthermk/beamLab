import type { Coverage, PhotometricDataset } from '../model/dataset';
import { flux } from '../geometry/flux';

export interface StepRange {
  min: number;
  max: number;
}

export interface DatasetSummary {
  /** Highest finite value on the grid (cd for 'intensity'); NaN if none. */
  maxIntensity: number;
  /** Grid position of the maximum (first occurrence, row-major). */
  maxAt: { h: number; v: number } | null;
  /** Flux in the covered region (lm for 'intensity'). */
  flux: number;
  /** Angular range of real data. */
  range: Coverage;
  /** Smallest and largest grid spacing per axis (degrees); NaN for a single-point axis. */
  step: { h: StepRange; v: StepRange };
}

function steps(axis: number[]): StepRange {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 1; i < axis.length; i++) {
    const d = Number((axis[i]! - axis[i - 1]!).toFixed(9));
    if (d < min) min = d;
    if (d > max) max = d;
  }
  return axis.length > 1 ? { min, max } : { min: NaN, max: NaN };
}

export function summarize(dataset: PhotometricDataset): DatasetSummary {
  const { h, v } = dataset.grid;
  let maxIntensity = NaN;
  let maxAt: { h: number; v: number } | null = null;
  for (let iv = 0; iv < v.length; iv++) {
    for (let ih = 0; ih < h.length; ih++) {
      const x = dataset.values[iv * h.length + ih]!;
      if (Number.isFinite(x) && !(x <= maxIntensity)) {
        maxIntensity = x;
        maxAt = { h: h[ih]!, v: v[iv]! };
      }
    }
  }
  return {
    maxIntensity,
    maxAt,
    flux: flux(dataset),
    range: { ...dataset.coverage },
    step: { h: steps(h), v: steps(v) },
  };
}
