import { createDataset, gridBounds, type Coverage, type Grid, type PhotometricDataset } from '../model/dataset';
import { makeProvenance, type Provenance } from '../model/provenance';
import { fnv1a } from '../model/hash';
import { anglesToVector, vectorToAngles, type Vec3 } from './coords';
import { ANGLE_EPS, sample } from './interpolate';
import { flux } from './flux';

/**
 * Rotate / aim (FRAMEWORK.md section 6.1).
 *
 * Axes (section 3.1): x forward, y right, z up. Angles in degrees.
 *   Yaw   ψ: rotation about z. Positive yaw moves the beam to the right (+H).
 *            Yaw(ψ)   = [[cψ, −sψ, 0], [sψ, cψ, 0], [0, 0, 1]]        forward → (cψ, sψ, 0)
 *   Pitch θ: rotation about y. Positive pitch moves the beam up (+V).
 *            Pitch(θ) = [[cθ, 0, −sθ], [0, 1, 0], [sθ, 0, cθ]]        forward → (cθ, 0, sθ)
 *   Roll  φ: rotation about x. Positive roll is clockwise as seen from the lamp
 *            looking forward (up → right → down → left).
 *            Roll(φ)  = [[1, 0, 0], [0, cφ, sφ], [0, −sφ, cφ]]        up → (0, sφ, cφ)
 *   Order: roll first, then pitch, then yaw:  R = Yaw(ψ) · Pitch(θ) · Roll(φ).
 *
 * R moves beam directions: a feature at direction d in the source is at R·d
 * after rotation. The rotated dataset is built as a true rotation on the
 * sphere: for each target node t, the value is the source sampled at Rᵀ·t
 * (Rᵀ = R⁻¹). It is never a shift of the V axis (only exact on H = 0).
 */

export type Mat3 = number[];

export interface Aim {
  yaw: number;
  pitch: number;
  roll: number;
}

export const ROTATION_ORDER = 'roll, then pitch, then yaw (R = Yaw · Pitch · Roll)';

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const round9 = (x: number) => {
  const r = Number(x.toFixed(9));
  return r === 0 ? 0 : r;
};

export function multiplyMatrices(a: Mat3, b: Mat3): Mat3 {
  const out: number[] = [];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) out.push(a[r * 3]! * b[c]! + a[r * 3 + 1]! * b[3 + c]! + a[r * 3 + 2]! * b[6 + c]!);
  }
  return out;
}

export function transpose(m: Mat3): Mat3 {
  return [m[0]!, m[3]!, m[6]!, m[1]!, m[4]!, m[7]!, m[2]!, m[5]!, m[8]!];
}

export function applyMatrix(m: Mat3, v: Vec3): Vec3 {
  return [
    m[0]! * v[0] + m[1]! * v[1] + m[2]! * v[2],
    m[3]! * v[0] + m[4]! * v[1] + m[5]! * v[2],
    m[6]! * v[0] + m[7]! * v[1] + m[8]! * v[2],
  ];
}

/** R = Yaw · Pitch · Roll (roll applied first). */
export function rotationMatrix(aim: Aim): Mat3 {
  const [cy, sy] = [Math.cos(aim.yaw * D2R), Math.sin(aim.yaw * D2R)];
  const [cp, sp] = [Math.cos(aim.pitch * D2R), Math.sin(aim.pitch * D2R)];
  const [cr, sr] = [Math.cos(aim.roll * D2R), Math.sin(aim.roll * D2R)];
  const yaw = [cy, -sy, 0, sy, cy, 0, 0, 0, 1];
  const pitch = [cp, 0, -sp, 0, 1, 0, sp, 0, cp];
  const roll = [1, 0, 0, 0, cr, sr, 0, -sr, cr];
  return multiplyMatrices(yaw, multiplyMatrices(pitch, roll));
}

/**
 * Yaw, pitch, roll of a rotation matrix (inverse of rotationMatrix, |pitch| < 90°).
 * From R = Yaw·Pitch·Roll: R·forward = (cψcθ, sψcθ, sθ); R[2][1] = −cθ·sφ, R[2][2] = cθ·cφ.
 */
export function anglesFromMatrix(m: Mat3): Aim {
  const pitch = Math.asin(Math.max(-1, Math.min(1, m[6]!))) * R2D;
  const yaw = Math.atan2(m[3]!, m[0]!) * R2D;
  const roll = Math.atan2(-m[7]!, m[8]!) * R2D;
  const z = (x: number) => (x === 0 ? 0 : x);
  return { yaw: z(yaw), pitch: z(pitch), roll: z(roll) };
}

/** Pitch in degrees from an inclination in percent: atan(percent / 100). 1% = 0.573°. */
export function pitchFromPercent(percent: number): number {
  return Math.atan(percent / 100) * R2D;
}

function isPureYaw(m: Mat3): boolean {
  const e = 1e-12;
  return Math.abs(m[2]!) < e && Math.abs(m[5]!) < e && Math.abs(m[6]!) < e && Math.abs(m[7]!) < e && Math.abs(m[8]! - 1) < e;
}

export type RotationTarget = 'same' | 'extended';

export interface RotateOptions {
  /** 'same' (default): the input's grid. 'extended': the input's grid extended to contain the rotated coverage. */
  target?: RotationTarget;
  /** Compose with a previous rotation and resample once from its original (default true). */
  compose?: boolean;
  name?: string;
  timestamp?: string;
  /** Largest extended grid allowed (nodes). Default 4 000 000. */
  maxPoints?: number;
}

export interface Peak {
  value: number;
  h: number;
  v: number;
}

export interface RotationReport {
  /** Share of target nodes whose source direction is outside the source coverage (0..1). */
  outsideFraction: number;
  fluxBefore: number;
  fluxAfter: number;
  /** 100 · (after − before) / before. */
  fluxChangePercent: number;
  peakBefore: Peak;
  peakAfter: Peak;
  /** True for a pure yaw: exact H shift, no resampling. */
  fastPath: boolean;
  /** True if composed with a previous rotation (resampled once from the original). */
  composed: boolean;
  /** Total rotation from the original source. */
  composedAngles: Aim;
}

export class RotationError extends Error {
  override name = 'RotationError';
  readonly code = 'GRID_TOO_LARGE';
}

function peakOf(ds: PhotometricDataset): Peak {
  let best: Peak = { value: NaN, h: NaN, v: NaN };
  const { h, v } = ds.grid;
  for (let iv = 0; iv < v.length; iv++) {
    for (let ih = 0; ih < h.length; ih++) {
      const x = ds.values[iv * h.length + ih]!;
      if (Number.isFinite(x) && !(x <= best.value)) best = { value: x, h: h[ih]!, v: v[iv]! };
    }
  }
  return best;
}

function inCoverage(c: Coverage, h: number, v: number): boolean {
  return h >= c.hMin - ANGLE_EPS && h <= c.hMax + ANGLE_EPS && v >= c.vMin - ANGLE_EPS && v <= c.vMax + ANGLE_EPS;
}

/** Type A bounding box of the source coverage after rotation by R (boundary sampling plus pole check). */
function rotatedBox(c: Coverage, m: Mat3): Coverage {
  let hMin = Infinity, hMax = -Infinity, vMin = Infinity, vMax = -Infinity;
  const add = (h: number, v: number) => {
    const a = vectorToAngles('A', applyMatrix(m, anglesToVector('A', h, v)));
    vMin = Math.min(vMin, a.v);
    vMax = Math.max(vMax, a.v);
    if (Math.abs(a.v) < 90 - 1e-6) {
      hMin = Math.min(hMin, a.h);
      hMax = Math.max(hMax, a.h);
    }
  };
  const N = 400;
  for (let i = 0; i <= N; i++) {
    const h = c.hMin + ((c.hMax - c.hMin) * i) / N;
    const v = c.vMin + ((c.vMax - c.vMin) * i) / N;
    add(h, c.vMin);
    add(h, c.vMax);
    add(c.hMin, v);
    add(c.hMax, v);
  }
  // A pole inside the rotated region is not on its boundary
  const mt = transpose(m);
  for (const z of [1, -1]) {
    const s = vectorToAngles('A', applyMatrix(mt, [0, 0, z]));
    if (inCoverage(c, s.h, s.v)) {
      if (z > 0) vMax = 90;
      else vMin = -90;
      hMin = -180;
      hMax = 180;
    }
  }
  return { hMin, hMax, vMin, vMax };
}

/** The axis extended at each end with its edge spacing until it covers [lo, hi] (clamped to the limits). */
function extendAxis(axis: number[], lo: number, hi: number, limLo: number, limHi: number): number[] {
  const out = [...axis];
  const s0 = axis.length > 1 ? axis[1]! - axis[0]! : 1;
  const s1 = axis.length > 1 ? axis[axis.length - 1]! - axis[axis.length - 2]! : 1;
  while (out[0]! > lo + ANGLE_EPS && out[0]! > limLo + ANGLE_EPS) out.unshift(Math.max(limLo, round9(out[0]! - s0)));
  while (out[out.length - 1]! < hi - ANGLE_EPS && out[out.length - 1]! < limHi - ANGLE_EPS) out.push(Math.min(limHi, round9(out[out.length - 1]! + s1)));
  return out;
}

export interface RotationPlan {
  /** True if the input is a rotation result and the rotations will be composed. */
  composed: boolean;
  /** True if the total rotation is a pure yaw that keeps H within ±180: exact H shift, no resampling. */
  fastPath: boolean;
  /** Total rotation from the dataset that will actually be sampled. */
  total: Aim;
  /** Name of the dataset that will actually be sampled. */
  originalName: string;
}

/** What rotate() will do, without running it. */
export function planRotation(input: PhotometricDataset, aim: Aim, opts: Pick<RotateOptions, 'compose'> = {}): RotationPlan {
  const link = (opts.compose ?? true) ? input.rotationOf : undefined;
  const source = link ? link.source : input;
  const rTotal = link ? multiplyMatrices(rotationMatrix(aim), link.matrix) : rotationMatrix(aim);
  const total = anglesFromMatrix(rTotal);
  const h = source.grid.h;
  const fastPath = isPureYaw(rTotal) && h[0]! + total.yaw >= -180 - ANGLE_EPS && h[h.length - 1]! + total.yaw <= 180 + ANGLE_EPS;
  return { composed: !!link, fastPath, total, originalName: source.name };
}

/**
 * Rotates a dataset (any kind). Returns the new dataset and a report.
 * Pure yaw is an exact shift of the H grid (no resampling). If the input is
 * itself a rotation result, the rotations are composed and the original is
 * resampled once (no accumulated blur), unless compose is false.
 */
export function rotate(input: PhotometricDataset, aim: Aim, opts: RotateOptions = {}): { dataset: PhotometricDataset; report: RotationReport } {
  const target = opts.target ?? 'same';
  const link = (opts.compose ?? true) ? input.rotationOf : undefined;
  const source = link ? link.source : input;
  const rStep = rotationMatrix(aim);
  const rTotal = link ? multiplyMatrices(rStep, link.matrix) : rStep;
  const total = anglesFromMatrix(rTotal);

  let grid: Grid;
  let values: Float64Array;
  let coverage: Coverage;
  let outside = 0;
  let fastPath = false;

  const shifted = source.grid.h.map((h) => round9(h + total.yaw));
  if (isPureYaw(rTotal) && shifted[0]! >= -180 - ANGLE_EPS && shifted[shifted.length - 1]! <= 180 + ANGLE_EPS) {
    // Exact H shift: values unchanged, no resampling
    fastPath = true;
    grid = { h: shifted.map((h) => Math.max(-180, Math.min(180, h))), v: [...source.grid.v] };
    values = source.values.slice();
    coverage = { ...source.coverage, hMin: round9(source.coverage.hMin + total.yaw), hMax: round9(source.coverage.hMax + total.yaw) };
  } else {
    if (target === 'extended') {
      const box = rotatedBox(source.coverage, rTotal);
      const b = gridBounds(input.grid);
      grid = {
        h: extendAxis(input.grid.h, Math.min(box.hMin, b.hMin), Math.max(box.hMax, b.hMax), -180, 180),
        v: extendAxis(input.grid.v, Math.min(box.vMin, b.vMin), Math.max(box.vMax, b.vMax), -90, 90),
      };
      const n = grid.h.length * grid.v.length;
      const max = opts.maxPoints ?? 4_000_000;
      if (n > max) {
        throw new RotationError(
          `The extended grid would have ${grid.h.length} × ${grid.v.length} = ${n.toLocaleString('en-US')} nodes, too large (limit ${max.toLocaleString('en-US')}). Use the same grid, or a smaller rotation.`,
        );
      }
    } else {
      grid = { h: [...input.grid.h], v: [...input.grid.v] };
    }
    const rt = transpose(rTotal);
    const nH = grid.h.length;
    values = new Float64Array(nH * grid.v.length);
    let hMin = Infinity, hMax = -Infinity, vMin = Infinity, vMax = -Infinity;
    for (let iv = 0; iv < grid.v.length; iv++) {
      const v = grid.v[iv]!;
      for (let ih = 0; ih < nH; ih++) {
        const h = grid.h[ih]!;
        const s = vectorToAngles('A', applyMatrix(rt, anglesToVector('A', h, v)));
        let x = NaN;
        if (inCoverage(source.coverage, s.h, s.v)) x = sample(source, s.h, s.v);
        else outside++;
        values[iv * nH + ih] = x;
        if (Number.isFinite(x)) {
          hMin = Math.min(hMin, h);
          hMax = Math.max(hMax, h);
          vMin = Math.min(vMin, v);
          vMax = Math.max(vMax, v);
        }
      }
    }
    coverage = Number.isFinite(hMin) ? { hMin, hMax, vMin, vMax } : gridBounds(grid);
  }

  const outsideFraction = outside / values.length;
  const params: Record<string, unknown> = {
    inputNames: [input.name],
    yaw: aim.yaw,
    pitch: aim.pitch,
    roll: aim.roll,
    order: ROTATION_ORDER,
    target: fastPath ? 'shifted (pure yaw)' : target,
    interpolation: fastPath ? 'none (exact H shift)' : 'bilinear',
    composed: !!link,
    composedAngles: total,
    resampledFrom: source.name,
    matrix: rTotal.map((x) => Number(x.toPrecision(15))),
    outsideFraction,
  };
  const provenance: Provenance = {
    ...makeProvenance('rotate', [input.id], params, opts.timestamp),
    parents: [{ id: input.id, name: input.name, kind: input.kind, provenance: input.provenance }],
  };
  const r = (x: number) => Number(x.toPrecision(6));
  const dataset = createDataset({
    id: `rotate-${fnv1a(JSON.stringify([input.id, source.id, rTotal, target]))}`,
    name: opts.name ?? `${input.name} rotated (yaw ${r(aim.yaw)}, pitch ${r(aim.pitch)}, roll ${r(aim.roll)})`,
    kind: input.kind,
    grid,
    values,
    coverage,
    meta: { ...input.meta, keywords: [], sourceFormat: 'derived' },
    provenance,
    rotationOf: { source, matrix: rTotal },
  });

  const fluxBefore = flux(input);
  const fluxAfter = flux(dataset);
  return {
    dataset,
    report: {
      outsideFraction,
      fluxBefore,
      fluxAfter,
      fluxChangePercent: fluxBefore !== 0 ? (100 * (fluxAfter - fluxBefore)) / fluxBefore : NaN,
      peakBefore: peakOf(input),
      peakAfter: peakOf(dataset),
      fastPath,
      composed: !!link,
      composedAngles: total,
    },
  };
}
