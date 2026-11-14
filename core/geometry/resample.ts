import { createDataset, type Grid, type PhotometricDataset, type PhotometricType } from '../model/dataset';
import { makeProvenance } from '../model/provenance';
import { anglesToVector, AXIS_ASSUMPTIONS, vectorToAngles, type AxisAssumptions } from './coords';
import { ANGLE_EPS, bilinear, sample } from './interpolate';

/** A grid in its own photometric type (h = H or C, v = V or γ), values row-major [v][h]. */
export interface SourceGrid {
  type: PhotometricType;
  h: number[];
  v: number[];
  values: Float64Array;
}

export interface TypeAResult {
  grid: Grid;
  values: Float64Array;
  /** Step actually used (degrees). */
  step: number;
  /** Step chosen from the source before any coarsening. */
  requestedStep: number;
  /** True if the step was increased to stay under maxPoints. */
  coarsened: boolean;
}

const round9 = (x: number): number => {
  const r = Number(x.toFixed(9));
  return r === 0 ? 0 : r;
};

/** Finest positive spacing found on any of the axes, rounded to 1e-6 degrees. Defaults to 1. */
export function chooseTargetStep(...axes: number[][]): number {
  let min = Infinity;
  for (const axis of axes) {
    for (let i = 1; i < axis.length; i++) {
      const d = axis[i]! - axis[i - 1]!;
      if (d > ANGLE_EPS && d < min) min = d;
    }
  }
  return Number.isFinite(min) ? Number(min.toFixed(6)) : 1;
}

/** Multiples of step within [min, max], plus min and max themselves. */
function uniformAxis(min: number, max: number, step: number): number[] {
  const out: number[] = [];
  const k0 = Math.ceil(min / step - 1e-9);
  const k1 = Math.floor(max / step + 1e-9);
  for (let k = k0; k <= k1; k++) out.push(round9(k * step));
  if (out.length === 0 || out[0]! > min + ANGLE_EPS) out.unshift(min);
  if (out[out.length - 1]! < max - ANGLE_EPS) out.push(max);
  return out;
}

/**
 * Converts a Type B or C grid to a canonical Type A grid: for each Type A
 * target direction, convert to the source's angles and sample bilinearly.
 * The target is uniform at `step` (default: finest source step) over the full
 * sphere, then cropped to the rows/columns that contain data.
 * Returns null if no target point falls inside the source data.
 */
export function resampleToTypeA(
  src: SourceGrid,
  options: { step?: number; maxPoints?: number; axes?: AxisAssumptions } = {},
): TypeAResult | null {
  const axes = options.axes ?? AXIS_ASSUMPTIONS;
  const requestedStep = options.step ?? chooseTargetStep(src.h, src.v);
  const maxPoints = options.maxPoints ?? 4_000_000;
  let step = requestedStep;
  const count = (s: number) => uniformAxis(-180, 180, s).length * uniformAxis(-90, 90, s).length;
  while (count(step) > maxPoints) step = Number((step * 1.25).toFixed(6));

  const hAll = uniformAxis(-180, 180, step);
  const vAll = uniformAxis(-90, 90, step);
  const nH = hAll.length;
  const full = new Float64Array(nH * vAll.length);
  // At V = ±90 every H is the same direction (the pole), so pole rows would
  // make every column look covered. Columns are cropped on non-pole rows only.
  let rMin = Infinity, rMax = -1, cMin = Infinity, cMax = -1;
  let pcMin = Infinity, pcMax = -1;
  for (let iv = 0; iv < vAll.length; iv++) {
    const isPole = Math.abs(Math.abs(vAll[iv]!) - 90) < ANGLE_EPS;
    for (let ih = 0; ih < nH; ih++) {
      const d = anglesToVector('A', hAll[ih]!, vAll[iv]!);
      const s = vectorToAngles(src.type, d, axes);
      let val = bilinear(src.h, src.v, src.values, s.h, s.v);
      // Type C: C = 0 and C = 360 are the same plane; retry the other end.
      if (Number.isNaN(val) && src.type === 'C' && s.h < ANGLE_EPS) {
        val = bilinear(src.h, src.v, src.values, 360, s.v);
      }
      full[iv * nH + ih] = val;
      if (Number.isFinite(val)) {
        if (iv < rMin) rMin = iv;
        if (iv > rMax) rMax = iv;
        if (isPole) {
          if (ih < pcMin) pcMin = ih;
          if (ih > pcMax) pcMax = ih;
        } else {
          if (ih < cMin) cMin = ih;
          if (ih > cMax) cMax = ih;
        }
      }
    }
  }
  if (rMax < 0) return null;
  if (cMax < 0) {
    // Only pole rows have data
    cMin = pcMin;
    cMax = pcMax;
  }

  const h = hAll.slice(cMin, cMax + 1);
  const v = vAll.slice(rMin, rMax + 1);
  const values = new Float64Array(h.length * v.length);
  for (let iv = 0; iv < v.length; iv++) {
    for (let ih = 0; ih < h.length; ih++) values[iv * h.length + ih] = full[(iv + rMin) * nH + ih + cMin]!;
  }
  return { grid: { h, v }, values, step, requestedStep, coarsened: step !== requestedStep };
}

/** Resamples a canonical dataset onto another Type A grid (bilinear). Returns a new derived dataset. */
export function resample(dataset: PhotometricDataset, target: Grid): PhotometricDataset {
  const values = new Float64Array(target.h.length * target.v.length);
  let hMin = Infinity, hMax = -Infinity, vMin = Infinity, vMax = -Infinity;
  target.v.forEach((v, iv) =>
    target.h.forEach((h, ih) => {
      const val = sample(dataset, h, v);
      values[iv * target.h.length + ih] = val;
      if (Number.isFinite(val)) {
        hMin = Math.min(hMin, h);
        hMax = Math.max(hMax, h);
        vMin = Math.min(vMin, v);
        vMax = Math.max(vMax, v);
      }
    }),
  );
  return createDataset({
    id: `${dataset.id}~resample`,
    name: dataset.name,
    kind: dataset.kind,
    grid: { h: [...target.h], v: [...target.v] },
    values,
    coverage: Number.isFinite(hMin) ? { hMin, hMax, vMin, vMax } : { hMin: NaN, hMax: NaN, vMin: NaN, vMax: NaN },
    meta: dataset.meta,
    provenance: makeProvenance('resample', [dataset.id], { targetGrid: target, interpolation: 'bilinear' }),
  });
}
