import {
  createDataset,
  type Coverage,
  type DatasetKind,
  type DatasetMeta,
  type Grid,
  type PhotometricDataset,
} from '../model/dataset';
import { makeProvenance, type Provenance, type ProvenanceParent } from '../model/provenance';
import { fnv1a } from '../model/hash';
import { commonGrid, GridError, valuesOnGrid, type Extent } from '../geometry/resample';
import { ANGLE_EPS } from '../geometry/interpolate';

/**
 * Arithmetic on datasets (FRAMEWORK.md section 6). Every operation returns a
 * new dataset with provenance; inputs are never modified. Binary operations
 * follow align → common grid → operate → tag provenance. NaN in any input
 * gives NaN in the result.
 */

export type OperationErrorCode =
  | 'KIND'
  | 'BAD_SCALE'
  | 'BAD_WEIGHTS'
  | 'BAD_FLOOR'
  | 'BAD_WINDOW'
  | 'NO_OVERLAP'
  | 'GRID_TOO_LARGE';

export class OperationError extends Error {
  override name = 'OperationError';
  readonly code: OperationErrorCode;
  constructor(code: OperationErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export type BinaryOp = 'add' | 'subtract' | 'multiply' | 'divide';

export interface CommonOptions {
  /** Result name. Default: built from the input names. */
  name?: string;
  /** Provenance timestamp. Default: now. */
  timestamp?: string;
}

export interface BinaryOptions extends CommonOptions {
  /** Default 'intersection'. */
  extent?: Extent;
  /** Treat "no data" in an input (outside its coverage, or NaN) as zero instead of NaN. */
  zeroOutside?: { a?: boolean; b?: boolean };
  /** Largest merged grid allowed. Default 4 000 000 nodes. */
  maxPoints?: number;
}

const SIGNED: DatasetKind[] = ['intensity', 'difference'];

function kindError(message: string): never {
  throw new OperationError('KIND', message);
}

/** Kind of the result of a binary operation; throws OperationError('KIND') if the inputs are not allowed. */
export function binaryResultKind(op: BinaryOp, a: DatasetKind, b: DatasetKind, weights: [number, number] = [1, 1]): DatasetKind {
  switch (op) {
    case 'add':
      if (!SIGNED.includes(a) || !SIGNED.includes(b)) kindError(`Add needs intensity or difference inputs; got ${a} and ${b}.`);
      return a === 'intensity' && b === 'intensity' && weights[0] >= 0 && weights[1] >= 0 ? 'intensity' : 'difference';
    case 'subtract':
      if (!SIGNED.includes(a) || !SIGNED.includes(b)) kindError(`Subtract needs intensity or difference inputs; got ${a} and ${b}.`);
      return 'difference';
    case 'multiply':
      if (b !== 'ratio' && b !== 'mask') {
        kindError(
          `B must be a ratio or a mask (got ${b}). Multiplying two intensities has no physical meaning; ` +
            'use Scale for a constant factor, or Divide to make a ratio map first.',
        );
      }
      if (a === 'mask') kindError('A cannot be a mask; multiply the intensity by the mask instead (A = intensity, B = mask).');
      return a;
    case 'divide':
      if (!SIGNED.includes(a) || b !== 'intensity') kindError(`Divide needs A intensity or difference and B intensity; got ${a} and ${b}.`);
      return 'ratio';
  }
}

function derivedMeta(from: PhotometricDataset): DatasetMeta {
  return {
    keywords: [],
    lumens: null,
    multiplier: 1,
    ballastFactor: 1,
    ballastLampFactor: 1,
    watts: 0,
    dimensions: from.meta.dimensions,
    sourceType: 'A',
    sourceFormat: 'derived',
  };
}

const parent = (d: PhotometricDataset): ProvenanceParent => ({ id: d.id, name: d.name, kind: d.kind, provenance: d.provenance });

function finish(
  op: string,
  inputs: PhotometricDataset[],
  params: Record<string, unknown>,
  init: { name: string; kind: DatasetKind; grid: Grid; values: Float64Array; coverage: Coverage; metaFrom: PhotometricDataset },
  timestamp: string | undefined,
): PhotometricDataset {
  const provenance: Provenance = {
    ...makeProvenance(op, inputs.map((d) => d.id), params, timestamp),
    parents: inputs.map(parent),
  };
  return createDataset({
    id: `${op}-${fnv1a(JSON.stringify([op, inputs.map((d) => d.id), params]))}`,
    name: init.name,
    kind: init.kind,
    grid: { h: [...init.grid.h], v: [...init.grid.v] },
    values: init.values,
    coverage: init.coverage,
    meta: derivedMeta(init.metaFrom),
    provenance,
  });
}

function grid2(a: PhotometricDataset, b: PhotometricDataset, opts: BinaryOptions) {
  try {
    return commonGrid(a, b, { extent: opts.extent ?? 'intersection', ...(opts.maxPoints ? { maxPoints: opts.maxPoints } : {}) });
  } catch (e) {
    if (e instanceof GridError) throw new OperationError(e.code, e.message);
    throw e;
  }
}

function binary(
  op: BinaryOp,
  a: PhotometricDataset,
  b: PhotometricDataset,
  opts: BinaryOptions,
  kind: DatasetKind,
  defaultName: string,
  extra: Record<string, unknown>,
  fn: (x: number, y: number) => number,
): PhotometricDataset {
  const cg = grid2(a, b, opts);
  const zero = { a: opts.zeroOutside?.a ?? false, b: opts.zeroOutside?.b ?? false };
  const va = valuesOnGrid(a, cg.grid, { zeroOutside: zero.a });
  const vb = valuesOnGrid(b, cg.grid, { zeroOutside: zero.b });
  const values = new Float64Array(va.length);
  for (let i = 0; i < values.length; i++) values[i] = fn(va[i]!, vb[i]!);
  const params = {
    inputNames: [a.name, b.name],
    ...extra,
    extent: opts.extent ?? 'intersection',
    zeroOutside: zero,
    resampled: !cg.identical,
    grid: { h: cg.grid.h.length, v: cg.grid.v.length },
  };
  return finish(op, [a, b], params, { name: opts.name ?? defaultName, kind, grid: cg.grid, values, coverage: cg.coverage, metaFrom: a }, opts.timestamp);
}

/** a·A + b·B (default weights 1, 1). Intensity + intensity with weights ≥ 0 gives intensity; otherwise a difference. */
export function add(a: PhotometricDataset, b: PhotometricDataset, opts: BinaryOptions & { weights?: [number, number] } = {}): PhotometricDataset {
  const w = opts.weights ?? [1, 1];
  if (!Number.isFinite(w[0]) || !Number.isFinite(w[1])) throw new OperationError('BAD_WEIGHTS', 'Weights must be finite numbers.');
  const kind = binaryResultKind('add', a.kind, b.kind, w);
  const name = w[0] === 1 && w[1] === 1 ? `${a.name} + ${b.name}` : `${w[0]} x ${a.name} + ${w[1]} x ${b.name}`;
  return binary('add', a, b, opts, kind, name, { weights: [w[0], w[1]] }, (x, y) => w[0] * x + w[1] * y);
}

/** A − B as a signed 'difference'; negative values are kept. */
export function subtract(a: PhotometricDataset, b: PhotometricDataset, opts: BinaryOptions = {}): PhotometricDataset {
  const kind = binaryResultKind('subtract', a.kind, b.kind);
  return binary('subtract', a, b, opts, kind, `${a.name} - ${b.name}`, {}, (x, y) => x - y);
}

/** A × B where B is a 'ratio' or 'mask'. Intensity × intensity is rejected. */
export function multiply(a: PhotometricDataset, b: PhotometricDataset, opts: BinaryOptions = {}): PhotometricDataset {
  const kind = binaryResultKind('multiply', a.kind, b.kind);
  return binary('multiply', a, b, opts, kind, `${a.name} x ${b.name}`, {}, (x, y) => x * y);
}

/** Default denominator floor: 0.1% of the denominator's largest value. */
export function defaultFloor(b: PhotometricDataset): number {
  let max = 0;
  for (const x of b.values) if (Number.isFinite(x) && x > max) max = x;
  return max * 1e-3;
}

/** A / B as a 'ratio'. Where B is below the floor (cd) or has no data, the result is NaN. */
export function divide(a: PhotometricDataset, b: PhotometricDataset, opts: BinaryOptions & { floor?: number } = {}): PhotometricDataset {
  const kind = binaryResultKind('divide', a.kind, b.kind);
  if (opts.floor !== undefined && !(Number.isFinite(opts.floor) && opts.floor >= 0)) {
    throw new OperationError('BAD_FLOOR', 'The denominator floor must be a number ≥ 0 cd.');
  }
  const floor = opts.floor ?? defaultFloor(b);
  return binary('divide', a, b, opts, kind, `${a.name} / ${b.name}`, { floor, floorIsDefault: opts.floor === undefined }, (x, y) =>
    y >= floor && y !== 0 ? x / y : NaN,
  );
}

/** A × k for k ≥ 0. Intensity stays intensity. */
export function scale(a: PhotometricDataset, k: number, opts: CommonOptions = {}): PhotometricDataset {
  if (!Number.isFinite(k) || k < 0) {
    throw new OperationError('BAD_SCALE', `Scale factor must be a finite number ≥ 0 (got ${k}); negative factors are rejected. Use Subtract for differences.`);
  }
  if (a.kind === 'mask') kindError('A mask cannot be scaled.');
  const values = a.values.map((x) => x * k);
  return finish('scale', [a], { inputNames: [a.name], k }, { name: opts.name ?? `${a.name} x ${k}`, kind: a.kind, grid: a.grid, values, coverage: { ...a.coverage }, metaFrom: a }, opts.timestamp);
}

/** Turns a 'difference' into 'intensity' by setting negative values to zero. Only on explicit request. */
export function clampToIntensity(d: PhotometricDataset, opts: CommonOptions = {}): PhotometricDataset {
  if (d.kind !== 'difference') kindError(`Clamp works on a difference dataset; "${d.name}" is ${d.kind}.`);
  let clamped = 0;
  const values = d.values.map((x) => {
    if (x < 0) {
      clamped++;
      return 0;
    }
    return x;
  });
  return finish(
    'clamp',
    [d],
    { inputNames: [d.name], clampedNodes: clamped },
    { name: opts.name ?? `${d.name} (clamped)`, kind: 'intensity', grid: d.grid, values, coverage: { ...d.coverage }, metaFrom: d },
    opts.timestamp,
  );
}

export interface Window {
  hMin: number;
  hMax: number;
  vMin: number;
  vMax: number;
}

/** A 'mask' on `grid`: 1 inside the window (edges included), 0 outside. */
export function windowMask(grid: Grid, w: Window, opts: CommonOptions & { gridFrom?: { id: string; name: string } } = {}): PhotometricDataset {
  const ok = [w.hMin, w.hMax, w.vMin, w.vMax].every(Number.isFinite) && w.hMin <= w.hMax && w.vMin <= w.vMax;
  if (!ok) throw new OperationError('BAD_WINDOW', 'Window limits must be numbers with H min ≤ H max and V min ≤ V max.');
  const nH = grid.h.length;
  const values = new Float64Array(nH * grid.v.length);
  grid.v.forEach((v, iv) =>
    grid.h.forEach((h, ih) => {
      const inside = h >= w.hMin - ANGLE_EPS && h <= w.hMax + ANGLE_EPS && v >= w.vMin - ANGLE_EPS && v <= w.vMax + ANGLE_EPS;
      values[iv * nH + ih] = inside ? 1 : 0;
    }),
  );
  const name = opts.name ?? `window H ${w.hMin}..${w.hMax}, V ${w.vMin}..${w.vMax}`;
  const params: Record<string, unknown> = { inputNames: [], window: { ...w }, ...(opts.gridFrom ? { gridFrom: opts.gridFrom.name, gridFromId: opts.gridFrom.id } : {}) };
  const provenance: Provenance = makeProvenance('window', [], params, opts.timestamp);
  return createDataset({
    id: `window-${fnv1a(JSON.stringify([w, grid.h.length, grid.v.length, grid.h[0], grid.v[0], opts.gridFrom?.id]))}`,
    name,
    kind: 'mask',
    grid: { h: [...grid.h], v: [...grid.v] },
    values,
    meta: {
      keywords: [], lumens: null, multiplier: 1, ballastFactor: 1, ballastLampFactor: 1,
      watts: 0, dimensions: null, sourceType: 'A', sourceFormat: 'derived',
    },
    provenance,
  });
}

export type BinaryPlan =
  | { ok: true; identical: boolean; gridSize: { h: number; v: number }; coverage: Coverage; resultKind: DatasetKind }
  | { ok: false; code: OperationErrorCode; error: string };

/** What a binary operation would do, without running it (for the summary shown before running). */
export function planBinary(
  op: BinaryOp,
  a: PhotometricDataset,
  b: PhotometricDataset,
  opts: BinaryOptions & { weights?: [number, number] } = {},
): BinaryPlan {
  try {
    const resultKind = binaryResultKind(op, a.kind, b.kind, opts.weights);
    const cg = grid2(a, b, opts);
    return { ok: true, identical: cg.identical, gridSize: { h: cg.grid.h.length, v: cg.grid.v.length }, coverage: cg.coverage, resultKind };
  } catch (e) {
    if (e instanceof OperationError) return { ok: false, code: e.code, error: e.message };
    throw e;
  }
}

/** Number of nodes with a negative value (what clampToIntensity would set to zero). */
export function negativeCount(ds: PhotometricDataset): number {
  let n = 0;
  for (const x of ds.values) if (x < 0) n++;
  return n;
}
