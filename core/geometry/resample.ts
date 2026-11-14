import { createDataset, type Coverage, type Grid, type PhotometricDataset, type PhotometricType } from '../model/dataset';
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

// ── Common grid for binary operations (Phase 3) ───────────────────────────

export type Extent = 'intersection' | 'union';

export type GridErrorCode = 'NO_OVERLAP' | 'GRID_TOO_LARGE';

export class GridError extends Error {
  override name = 'GridError';
  readonly code: GridErrorCode;
  constructor(code: GridErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface CommonGridOptions {
  /** Default 'intersection'. */
  extent?: Extent;
  /** Nodes closer than this (degrees) are merged. Default 1e-6. */
  tolerance?: number;
  /** Largest merged grid allowed (nodes). Default 4 000 000. */
  maxPoints?: number;
}

export interface CommonGridResult {
  grid: Grid;
  /** True when both inputs have the same grid: operate node by node, no resampling. */
  identical: boolean;
  /** Extent of the result: intersection or union of the input coverages. */
  coverage: Coverage;
}

const DEFAULT_TOL = 1e-6;

function sameAxis(a: number[], b: number[], tol: number): boolean {
  return a.length === b.length && a.every((x, i) => Math.abs(x - b[i]!) <= tol);
}

/** Sorted union of both node sets inside [lo, hi], plus lo and hi; nodes closer than tol are merged. */
export function mergeAxes(a: number[], b: number[], lo: number, hi: number, tol = DEFAULT_TOL): number[] {
  const all = [...a, ...b, lo, hi].filter((x) => x >= lo - tol && x <= hi + tol).sort((x, y) => x - y);
  const out: number[] = [];
  for (const x of all) {
    const c = Math.min(hi, Math.max(lo, x));
    if (!out.length || c - out[out.length - 1]! > tol) out.push(c);
  }
  return out;
}

/**
 * Grid on which a binary operation is evaluated. Identical input grids are
 * kept as they are. Otherwise the grid is the merged set of both inputs'
 * nodes inside the extent, so neither input loses resolution.
 */
export function commonGrid(a: PhotometricDataset, b: PhotometricDataset, options: CommonGridOptions = {}): CommonGridResult {
  const extent = options.extent ?? 'intersection';
  const tol = options.tolerance ?? DEFAULT_TOL;
  const maxPoints = options.maxPoints ?? 4_000_000;
  const ca = a.coverage;
  const cb = b.coverage;
  const coverage: Coverage =
    extent === 'intersection'
      ? { hMin: Math.max(ca.hMin, cb.hMin), hMax: Math.min(ca.hMax, cb.hMax), vMin: Math.max(ca.vMin, cb.vMin), vMax: Math.min(ca.vMax, cb.vMax) }
      : { hMin: Math.min(ca.hMin, cb.hMin), hMax: Math.max(ca.hMax, cb.hMax), vMin: Math.min(ca.vMin, cb.vMin), vMax: Math.max(ca.vMax, cb.vMax) };
  if (coverage.hMin > coverage.hMax + tol || coverage.vMin > coverage.vMax + tol) {
    throw new GridError(
      'NO_OVERLAP',
      `The coverages do not overlap (A: H ${ca.hMin}..${ca.hMax}, V ${ca.vMin}..${ca.vMax}; ` +
        `B: H ${cb.hMin}..${cb.hMax}, V ${cb.vMin}..${cb.vMax}). Use the union extent, or choose datasets that overlap.`,
    );
  }
  if (sameAxis(a.grid.h, b.grid.h, tol) && sameAxis(a.grid.v, b.grid.v, tol)) {
    return { grid: a.grid, identical: true, coverage };
  }
  const h = mergeAxes(a.grid.h, b.grid.h, coverage.hMin, coverage.hMax, tol);
  const v = mergeAxes(a.grid.v, b.grid.v, coverage.vMin, coverage.vMax, tol);
  const n = h.length * v.length;
  if (n > maxPoints) {
    throw new GridError(
      'GRID_TOO_LARGE',
      `The merged grid would have ${h.length} × ${v.length} = ${n.toLocaleString('en-US')} nodes, more than the limit of ` +
        `${maxPoints.toLocaleString('en-US')}. Use the intersection extent, or resample one input onto the other's grid first.`,
    );
  }
  return { grid: { h, v }, identical: false, coverage };
}

/**
 * Values of a dataset on a grid: exact on its own grid (masked to its
 * coverage), bilinear `sample()` otherwise. Where the dataset has no data
 * (outside coverage, or NaN) the value is NaN, or 0 if zeroOutside is set.
 */
export function valuesOnGrid(ds: PhotometricDataset, grid: Grid, options: { zeroOutside?: boolean } = {}): Float64Array {
  const nH = grid.h.length;
  const out = new Float64Array(nH * grid.v.length);
  const own = sameAxis(ds.grid.h, grid.h, DEFAULT_TOL) && sameAxis(ds.grid.v, grid.v, DEFAULT_TOL);
  const c = ds.coverage;
  for (let iv = 0; iv < grid.v.length; iv++) {
    const v = grid.v[iv]!;
    for (let ih = 0; ih < nH; ih++) {
      const h = grid.h[ih]!;
      let x: number;
      if (own) {
        const inside = h >= c.hMin - ANGLE_EPS && h <= c.hMax + ANGLE_EPS && v >= c.vMin - ANGLE_EPS && v <= c.vMax + ANGLE_EPS;
        x = inside ? ds.values[iv * nH + ih]! : NaN;
      } else {
        x = sample(ds, h, v);
      }
      out[iv * nH + ih] = Number.isNaN(x) && options.zeroOutside ? 0 : x;
    }
  }
  return out;
}
