import type { PhotometricDataset } from '../model/dataset';
import { sample } from '../geometry/interpolate';
import { applyMatrix, multiplyMatrices, rotationMatrix, transpose, type Aim, type Mat3 } from '../geometry/rotate';
import type { Vec3 } from '../geometry/coords';

/**
 * Road illuminance (FRAMEWORK.md section 5.2). Ported from Road-illuminate
 * (headlamp_road_illuminance.py, "road" method) onto this repo's dataset model.
 *
 * Vehicle frame: x forward, y right, z up (metres). The road surface is z = 0.
 * The origin is on the ground below the centre of the vehicle front.
 *
 * Lamp: a dataset (canonical Type A, cd), a position (x, y, height) and an aim
 * (yaw, pitch, roll) with the Phase 4 signs: positive yaw turns the beam right,
 * positive pitch up, positive roll clockwise seen from the lamp. The aim is the
 * rotation R = Yaw · Pitch · Roll that moves beam directions, so a ray with
 * vehicle direction u leaves the lamp at lamp-frame direction Rᵀ · u.
 *
 * For a point P on a plane with unit normal n (pointing towards the side that
 * is lit):  d = P − L,  r = |d|,  u = d / r,  cos θ = −u · n,
 *   E = I(H, V) · cos θ / r²
 * where (H, V) are the Type A angles of Rᵀ · u. On the road (n = +z) this is
 * E = I · h / r³ with h the lamp height. A plane facing away from a lamp
 * (cos θ ≤ 0) gets nothing from it.
 *
 * Coverage: a ray whose (H, V) is outside the lamp's data (sample() gives NaN)
 * makes the point unknown (NaN), unless `outside: 'zero'` is set.
 *
 * This file depends only on core/model and core/geometry, so core/road can be
 * extracted as a shared package.
 */

export interface LampPosition {
  /** Forward of the origin, m. */
  x: number;
  /** Right of the vehicle centre line, m. */
  y: number;
  /** Height of the lamp centre above the road, m. */
  height: number;
}

export interface RoadLamp {
  name?: string;
  dataset: PhotometricDataset;
  position: LampPosition;
  aim: Aim;
  /** Use the dataset mirrored in H (H → −H in the lamp frame, before the aim). Default false. */
  mirror?: boolean;
}

export type OutsidePolicy = 'unknown' | 'zero';

export interface IlluminanceOptions {
  /** Ray outside a lamp's coverage: 'unknown' (NaN, default) or 'zero'. */
  outside?: OutsidePolicy;
  /**
   * If a lamp's dataset is the result of a Phase 4 rotation, sample its
   * unrotated source with the combined rotation instead of the resampled
   * values (one interpolation instead of two). Default true.
   */
  composeRotation?: boolean;
}

export class RoadError extends Error {
  override name = 'RoadError';
}

/** A lamp ready for evaluation: world-to-lamp matrix and dataset to sample. */
interface PreparedLamp {
  px: number;
  py: number;
  pz: number;
  /** Rᵀ, row-major. */
  toLamp: Mat3;
  dataset: PhotometricDataset;
  mirror: boolean;
}

const R2D = 180 / Math.PI;

function checkLamp(l: RoadLamp, i: number): void {
  const label = l.name ?? `lamp ${i + 1}`;
  if (l.dataset.kind !== 'intensity') throw new RoadError(`${label}: dataset must be an intensity distribution (cd), not ${l.dataset.kind}`);
  const nums: Array<[string, number]> = [
    ['position x', l.position.x], ['position y', l.position.y], ['height', l.position.height],
    ['yaw', l.aim.yaw], ['pitch', l.aim.pitch], ['roll', l.aim.roll],
  ];
  for (const [k, v] of nums) if (typeof v !== 'number' || !Number.isFinite(v)) throw new RoadError(`${label}: ${k} must be a number`);
}

function prepare(lamps: RoadLamp[], opts: IlluminanceOptions): PreparedLamp[] {
  if (lamps.length === 0) throw new RoadError('no lamps');
  return lamps.map((l, i) => {
    checkLamp(l, i);
    let r = rotationMatrix(l.aim);
    let dataset = l.dataset;
    const link = (opts.composeRotation ?? true) ? dataset.rotationOf : undefined;
    if (link) {
      // Mirror acts in the lamp frame of the dataset as loaded; only compose when not mirrored.
      if (!l.mirror) {
        r = multiplyMatrices(r, link.matrix);
        dataset = link.source;
      }
    }
    return { px: l.position.x, py: l.position.y, pz: l.position.height, toLamp: transpose(r), dataset, mirror: !!l.mirror };
  });
}

/** Lamp-frame Type A angles (degrees) of a vehicle-frame unit direction. */
export function lampAngles(toLamp: Mat3, u: Vec3, mirror = false): { h: number; v: number } {
  const d = applyMatrix(toLamp, u);
  const v = Math.asin(Math.max(-1, Math.min(1, d[2]))) * R2D;
  const h = Math.atan2(d[1], d[0]) * R2D;
  return { h: mirror ? -h : h, v };
}

function evalPoint(prep: PreparedLamp[], x: number, y: number, z: number, nx: number, ny: number, nz: number, zeroOutside: boolean): number {
  let e = 0;
  for (const l of prep) {
    const dx = x - l.px;
    const dy = y - l.py;
    const dz = z - l.pz;
    const r = Math.hypot(dx, dy, dz);
    if (r < 1e-9) return NaN;
    const ux = dx / r;
    const uy = dy / r;
    const uz = dz / r;
    const cos = -(ux * nx + uy * ny + uz * nz);
    if (cos <= 0) continue;
    const m = l.toLamp;
    const lx = m[0]! * ux + m[1]! * uy + m[2]! * uz;
    const ly = m[3]! * ux + m[4]! * uy + m[5]! * uz;
    const lz = m[6]! * ux + m[7]! * uy + m[8]! * uz;
    const v = Math.asin(Math.max(-1, Math.min(1, lz))) * R2D;
    let h = Math.atan2(ly, lx) * R2D;
    if (l.mirror) h = -h;
    const i = sample(l.dataset, h, v);
    if (Number.isNaN(i)) {
      if (zeroOutside) continue;
      return NaN;
    }
    e += (i * cos) / (r * r);
  }
  return e;
}

function unitNormal(n: Vec3): [number, number, number] {
  const len = Math.hypot(n[0], n[1], n[2]);
  if (!(len > 0) || !Number.isFinite(len)) throw new RoadError('plane normal must be a non-zero vector');
  return [n[0] / len, n[1] / len, n[2] / len];
}

/** Road surface: normal +z. */
export const ROAD_NORMAL: Vec3 = [0, 0, 1];
/** Vertical plane facing the vehicle: normal −x (towards the lamps). */
export const FACING_VEHICLE: Vec3 = [-1, 0, 0];

/** Illuminance (lx) at one point with a given plane normal. NaN if unknown. */
export function illuminanceAt(lamps: RoadLamp[], point: Vec3, normal: Vec3 = ROAD_NORMAL, opts: IlluminanceOptions = {}): number {
  const n = unitNormal(normal);
  return evalPoint(prepare(lamps, opts), point[0], point[1], point[2], n[0], n[1], n[2], opts.outside === 'zero');
}

// ── Grids ────────────────────────────────────────────────────────────────

export interface AxisRange {
  min: number;
  max: number;
  step: number;
}

/** Largest grid allowed by default (points). */
export const DEFAULT_MAX_POINTS = 1_000_000;

/** Axis values min, min + step, … ≤ max (max included when it lies on the step). */
function checkRange(a: AxisRange, label: string): true {
  if (![a.min, a.max, a.step].every(Number.isFinite)) throw new RoadError(`${label}: min, max and step must be numbers`);
  if (!(a.step > 0)) throw new RoadError(`${label}: step must be positive`);
  if (a.max < a.min) throw new RoadError(`${label}: max must not be below min`);
  return true;
}

export function axisValues(a: AxisRange, label = 'axis'): number[] {
  checkRange(a, label);
  const n = Math.floor((a.max - a.min) / a.step + 1e-9) + 1;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const v = Number((a.min + i * a.step).toFixed(9));
    out.push(v === 0 ? 0 : v);
  }
  return out;
}

export function gridSize(...axes: AxisRange[]): number {
  axes.forEach((a, i) => checkRange(a, `axis ${i + 1}`));
  return axes.reduce((p, a) => p * (Math.floor((a.max - a.min) / a.step + 1e-9) + 1), 1);
}

export interface RoadGrid {
  x: AxisRange;
  y: AxisRange;
}

export interface GridOptions extends IlluminanceOptions {
  /** Size guard (points). Default DEFAULT_MAX_POINTS. */
  maxPoints?: number;
}

/** Illuminance on a plane, row-major [row][col]. */
export interface IlluminanceField {
  plane: 'road' | 'vertical';
  /** Column axis: x (road) or y (vertical plane), m. */
  cols: number[];
  /** Row axis: y (road) or z (vertical plane), m. */
  rows: number[];
  values: Float64Array;
  /** Vertical plane only: its distance x, m. */
  x?: number;
  unknownCount: number;
  /** Share of points that are unknown (0..1). */
  unknownFraction: number;
  outside: OutsidePolicy;
}

function guard(n: number, max: number | undefined): void {
  const limit = max ?? DEFAULT_MAX_POINTS;
  if (n > limit) throw new RoadError(`grid has ${n.toLocaleString('en')} points, more than the limit of ${limit.toLocaleString('en')}; use a larger step or a smaller range`);
}

/** Horizontal road surface (z = 0) over an x-y grid. values[iy * nx + ix]. */
export function roadIlluminance(lamps: RoadLamp[], grid: RoadGrid, opts: GridOptions = {}): IlluminanceField {
  guard(gridSize(grid.x, grid.y), opts.maxPoints);
  const xs = axisValues(grid.x, 'x');
  const ys = axisValues(grid.y, 'y');
  const prep = prepare(lamps, opts);
  const zero = opts.outside === 'zero';
  const values = new Float64Array(xs.length * ys.length);
  let unknown = 0;
  for (let iy = 0; iy < ys.length; iy++) {
    for (let ix = 0; ix < xs.length; ix++) {
      const e = evalPoint(prep, xs[ix]!, ys[iy]!, 0, 0, 0, 1, zero);
      if (Number.isNaN(e)) unknown++;
      values[iy * xs.length + ix] = e;
    }
  }
  return { plane: 'road', cols: xs, rows: ys, values, unknownCount: unknown, unknownFraction: values.length ? unknown / values.length : 0, outside: zero ? 'zero' : 'unknown' };
}

export interface VerticalPlane {
  /** Distance of the plane in front of the origin, m. */
  x: number;
  y: AxisRange;
  z: AxisRange;
}

/** Vertical plane x = const facing the vehicle (normal −x). values[iz * ny + iy]. */
export function verticalIlluminance(lamps: RoadLamp[], plane: VerticalPlane, opts: GridOptions = {}): IlluminanceField {
  if (!Number.isFinite(plane.x)) throw new RoadError('vertical plane: x must be a number');
  guard(gridSize(plane.y, plane.z), opts.maxPoints);
  const ys = axisValues(plane.y, 'y');
  const zs = axisValues(plane.z, 'z');
  const prep = prepare(lamps, opts);
  const zero = opts.outside === 'zero';
  const values = new Float64Array(ys.length * zs.length);
  let unknown = 0;
  for (let iz = 0; iz < zs.length; iz++) {
    for (let iy = 0; iy < ys.length; iy++) {
      const e = evalPoint(prep, plane.x, ys[iy]!, zs[iz]!, -1, 0, 0, zero);
      if (Number.isNaN(e)) unknown++;
      values[iz * ys.length + iy] = e;
    }
  }
  return { plane: 'vertical', x: plane.x, cols: ys, rows: zs, values, unknownCount: unknown, unknownFraction: values.length ? unknown / values.length : 0, outside: zero ? 'zero' : 'unknown' };
}

/** Evaluator for many single points with the lamps prepared once. */
export function makeEvaluator(lamps: RoadLamp[], opts: IlluminanceOptions = {}): (point: Vec3, normal?: Vec3) => number {
  const prep = prepare(lamps, opts);
  const zero = opts.outside === 'zero';
  return (p, normal = ROAD_NORMAL) => {
    const n = unitNormal(normal);
    return evalPoint(prep, p[0], p[1], p[2], n[0], n[1], n[2], zero);
  };
}
