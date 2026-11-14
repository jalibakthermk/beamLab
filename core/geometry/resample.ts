import { createDataset, type Grid, type PhotometricDataset, type PhotometricType } from '../model/dataset';
import { makeProvenance } from '../model/provenance';
import { anglesToVector, AXIS_ASSUMPTIONS, vectorToAngles, type AxisAssumptions } from './coords';
import { ANGLE_EPS, bilinear, bracket, sample } from './interpolate';

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

/** True if a direction (in the source's own angles) lies inside the source grid. */
function inSource(src: SourceGrid, h: number, v: number): boolean {
  if (!bracket(src.v, v)) return false;
  if (bracket(src.h, h)) return true;
  return src.type === 'C' && h < ANGLE_EPS && bracket(src.h, 360) !== null;
}

/**
 * Type A bounding box of the area the source covers. Union of
 * (1) a coarse pass over the sphere at `coarse` degrees, testing which
 *     directions fall inside the source grid, widened by `coarse`, and
 * (2) the directions of every source grid node (catches sources smaller
 *     than the coarse step), widened later by the caller's margin.
 * H is ignored at the poles (V = ±90), where it is undefined.
 */
function sourceBoxInA(src: SourceGrid, axes: AxisAssumptions, coarse: number) {
  let hMin = Infinity, hMax = -Infinity, vMin = Infinity, vMax = -Infinity;
  const add = (a: { h: number; v: number }, pad: number) => {
    vMin = Math.min(vMin, a.v - pad);
    vMax = Math.max(vMax, a.v + pad);
    if (Math.abs(a.v) < 90 - 1e-6) {
      hMin = Math.min(hMin, a.h - pad);
      hMax = Math.max(hMax, a.h + pad);
    }
  };
  for (const v of uniformAxis(-90, 90, coarse)) {
    for (const h of uniformAxis(-180, 180, coarse)) {
      const s = vectorToAngles(src.type, anglesToVector('A', h, v), axes);
      if (inSource(src, s.h, s.v)) add({ h, v }, coarse);
    }
  }
  for (const v of src.v) {
    for (const h of src.h) add(vectorToAngles('A', anglesToVector(src.type, h, v, axes)), 0);
  }
  if (!Number.isFinite(hMin)) {
    hMin = -180;
    hMax = 180;
  }
  return { hMin, hMax, vMin, vMax };
}

function maxSpacing(...axes: number[][]): number {
  let max = 0;
  for (const a of axes) for (let i = 1; i < a.length; i++) max = Math.max(max, a[i]! - a[i - 1]!);
  return max;
}

/**
 * Converts a Type B or C grid to a canonical Type A grid: for each Type A
 * target direction, convert to the source's angles and sample bilinearly.
 * The target is uniform at `step` (default: finest source step). It spans the
 * Type A bounding box of the area the source covers (see sourceBoxInA),
 * widened by a margin (the largest source spacing, at most 10°, and at least
 * two target steps), then
 * snapped outward to multiples of the step and cropped to the rows/columns
 * that contain data. The `maxPoints` limit applies to that box, not to the
 * full sphere, so a file covering part of the sphere keeps its own step.
 * Returns null if no target point falls inside the source data.
 */
export function resampleToTypeA(
  src: SourceGrid,
  options: { step?: number; maxPoints?: number; axes?: AxisAssumptions } = {},
): TypeAResult | null {
  const axes = options.axes ?? AXIS_ASSUMPTIONS;
  const requestedStep = options.step ?? chooseTargetStep(src.h, src.v);
  const maxPoints = options.maxPoints ?? 4_000_000;
  const box = sourceBoxInA(src, axes, Math.max(1, requestedStep));
  const spacing = Math.min(maxSpacing(src.h, src.v), 10);
  const targetAxes = (st: number) => {
    const m = Math.max(spacing, 2 * st);
    const snapLo = (x: number, lim: number) => Math.max(lim, Number((Math.floor((x - m) / st) * st).toFixed(9)));
    const snapHi = (x: number, lim: number) => Math.min(lim, Number((Math.ceil((x + m) / st) * st).toFixed(9)));
    return {
      h: uniformAxis(snapLo(box.hMin, -180), snapHi(box.hMax, 180), st),
      v: uniformAxis(snapLo(box.vMin, -90), snapHi(box.vMax, 90), st),
    };
  };
  let step = requestedStep;
  const count = (st: number) => {
    const t = targetAxes(st);
    return t.h.length * t.v.length;
  };
  while (count(step) > maxPoints) step = Number((step * 1.25).toFixed(6));

  const { h: hAll, v: vAll } = targetAxes(step);
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
