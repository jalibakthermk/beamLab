import type { PhotometricDataset } from '../model/dataset';
import { sample } from '../geometry/interpolate';

/**
 * Cut-off analysis (FRAMEWORK.md section 6.2).
 *
 * Gradient G(V) = log10 I(V) − log10 I(V + 0.1°), sampled bilinearly on the
 * full data at a fixed H. The cut-off is at the V of maximum G inside the
 * search window, refined between scan nodes with a 3-point parabola.
 * Intensity at or below zero gives G = NaN (never an error).
 */

/** The 0.1° step of the gradient definition. */
export const G_DELTA = 0.1;

export type TrafficSide = 'RHT' | 'LHT';

export interface ScanOptions {
  /** H of the vertical scan (degrees, positive right). */
  h: number;
  /** Search window (degrees). */
  vMin: number;
  vMax: number;
  /** Scan step (degrees). Default 0.05. */
  step?: number;
  /** Report other local maxima of G at or above this share of Gmax. Default 0.3. */
  secondaryFraction?: number;
  /** Maxima closer than this to a stronger one belong to it (degrees). Default 0.2 (2 × 0.1°). */
  minSeparation?: number;
}

export interface ScanResult {
  h: number;
  /** False if G has no finite positive maximum in the window (no fall-off of intensity). */
  found: boolean;
  /** Cut-off V (degrees), refined between scan nodes; NaN if not found. */
  v: number;
  /** Scan node with the largest G. */
  vNode: number;
  /** Largest G (log10 units per 0.1°), at the refined position. */
  gMax: number;
  curve: { v: number[]; i: number[]; g: number[] };
  /** Largest V spacing of the data grid inside the window (degrees). */
  nativeStep: number;
  /** True if nativeStep > 0.1°: G is then an interpolation artefact, not a measurement. */
  coarse: boolean;
  /** Other local maxima of G at or above secondaryFraction × Gmax, strongest first. */
  secondary: Array<{ v: number; g: number }>;
}

const round9 = (x: number) => {
  const r = Number(x.toFixed(9));
  return r === 0 ? 0 : r;
};

function gradientAt(ds: PhotometricDataset, h: number, v: number): { i: number; g: number } {
  const a = sample(ds, h, v);
  const b = sample(ds, h, v + G_DELTA);
  return { i: a, g: a > 0 && b > 0 ? Math.log10(a) - Math.log10(b) : NaN };
}

/** Largest spacing between consecutive data V nodes that overlap [lo, hi]. */
function nativeStepIn(axis: number[], lo: number, hi: number): number {
  let max = 0;
  for (let k = 1; k < axis.length; k++) {
    const a = axis[k - 1]!;
    const b = axis[k]!;
    if (b > lo && a < hi) max = Math.max(max, b - a);
  }
  return round9(max);
}

export function scanCutoff(ds: PhotometricDataset, o: ScanOptions): ScanResult {
  const step = o.step ?? 0.05;
  const frac = o.secondaryFraction ?? 0.3;
  const sep = o.minSeparation ?? 2 * G_DELTA;
  const v: number[] = [];
  for (let k = 0; o.vMin + k * step <= o.vMax + 1e-9; k++) v.push(round9(o.vMin + k * step));
  const i: number[] = [];
  const g: number[] = [];
  for (const vv of v) {
    const r = gradientAt(ds, o.h, vv);
    i.push(r.i);
    g.push(r.g);
  }
  const nativeStep = nativeStepIn(ds.grid.v, o.vMin, o.vMax + G_DELTA);
  const base = { h: o.h, curve: { v, i, g }, nativeStep, coarse: nativeStep > G_DELTA + 1e-9 };

  let k0 = -1;
  for (let k = 0; k < g.length; k++) if (Number.isFinite(g[k]!) && (k0 < 0 || g[k]! > g[k0]!)) k0 = k;
  // No finite G, or intensity never falls with V: there is no cut-off in the window
  if (k0 < 0 || !(g[k0]! > 0)) return { ...base, found: false, v: NaN, vNode: NaN, gMax: k0 < 0 ? NaN : g[k0]!, secondary: [] };

  // 3-point parabola through the maximum for a position between scan nodes
  let vRef = v[k0]!;
  let gRef = g[k0]!;
  const gm = g[k0 - 1];
  const gp = g[k0 + 1];
  if (gm !== undefined && gp !== undefined && Number.isFinite(gm) && Number.isFinite(gp)) {
    const den = gm - 2 * gRef + gp;
    if (den < 0) {
      const off = Math.max(-0.5, Math.min(0.5, (0.5 * (gm - gp)) / den));
      vRef = v[k0]! + off * step;
      gRef = gRef - 0.25 * (gm - gp) * off;
    }
  }

  // Secondary maxima: local maxima ≥ frac·Gmax, each at least `sep` from the primary and from stronger ones
  const cands: Array<{ v: number; g: number }> = [];
  for (let k = 1; k + 1 < g.length; k++) {
    const x = g[k]!;
    if (!Number.isFinite(x) || x < frac * gRef) continue;
    const l = g[k - 1]!;
    const r = g[k + 1]!;
    if ((Number.isNaN(l) || x >= l) && (Number.isNaN(r) || x >= r) && k !== k0) cands.push({ v: v[k]!, g: x });
  }
  cands.sort((a, b) => b.g - a.g);
  const secondary: Array<{ v: number; g: number }> = [];
  for (const c of cands) {
    if (Math.abs(c.v - vRef) <= sep + 1e-9) continue;
    if (secondary.some((s) => Math.abs(s.v - c.v) <= sep + 1e-9)) continue;
    secondary.push(c);
  }
  return { ...base, found: true, v: vRef, vNode: v[k0]!, gMax: gRef, secondary };
}

// ── Sharpness limits (from a preset; never hard-coded) ────────────────────

export interface Limits {
  min: number | null;
  max: number | null;
}

export interface SharpnessResult {
  status: 'pass' | 'fail' | 'no-limits';
  /** Smallest distance to a limit (negative when failing); null without limits or without a value. */
  margin: number | null;
}

export function evaluateSharpness(gMax: number, limits: Limits): SharpnessResult {
  if (limits.min === null && limits.max === null) return { status: 'no-limits', margin: null };
  if (!Number.isFinite(gMax)) return { status: 'fail', margin: null };
  const m: number[] = [];
  if (limits.min !== null) m.push(gMax - limits.min);
  if (limits.max !== null) m.push(limits.max - gMax);
  const margin = Math.min(...m);
  return { status: margin >= 0 ? 'pass' : 'fail', margin };
}

export interface CutoffPreset {
  id: string;
  title: string;
  source: string | null;
  revision: string | null;
  trafficSide: TrafficSide | null;
  scanH: number | null;
  vWindow: Limits;
  sharpness: Limits;
  notes?: string;
}

/** Validates a preset object (data/presets/cutoff/*.json). Throws with every problem listed. */
export function parseCutoffPreset(obj: unknown): CutoffPreset {
  const p: string[] = [];
  const o = (obj ?? {}) as Record<string, unknown>;
  if (typeof obj !== 'object' || obj === null) throw new Error('Invalid cut-off preset: not an object.');
  const str = (k: string, nullable: boolean) => {
    const x = o[k];
    if (!(typeof x === 'string' || (nullable && x === null))) p.push(`${k} must be a string${nullable ? ' or null' : ''}`);
  };
  const numOrNull = (x: unknown, name: string) => {
    if (!(x === null || (typeof x === 'number' && Number.isFinite(x)))) p.push(`${name} must be a number or null`);
  };
  const pair = (k: string) => {
    const x = o[k] as Record<string, unknown> | undefined;
    if (typeof x !== 'object' || x === null) {
      p.push(`${k} must be an object with min and max`);
      return;
    }
    numOrNull(x['min'], `${k}.min`);
    numOrNull(x['max'], `${k}.max`);
  };
  str('id', false);
  str('title', false);
  str('source', true);
  str('revision', true);
  if (!(o['trafficSide'] === 'RHT' || o['trafficSide'] === 'LHT' || o['trafficSide'] === null)) p.push('trafficSide must be "RHT", "LHT" or null');
  numOrNull(o['scanH'], 'scanH');
  pair('vWindow');
  pair('sharpness');
  if (o['notes'] !== undefined && typeof o['notes'] !== 'string') p.push('notes must be a string');
  if (p.length) throw new Error(`Invalid cut-off preset: ${p.join('; ')}.`);
  return o as unknown as CutoffPreset;
}

// ── Cut-off line trace and two-segment fit ───────────────────────────────

export interface TraceOptions {
  hMin: number;
  hMax: number;
  hStep: number;
  vMin: number;
  vMax: number;
  step?: number;
  traffic: TrafficSide;
  /** Scans with Gmax below this are treated as "no cut-off here". Default 0.05. */
  minG?: number;
  /** Fit is flagged as poor above this RMS residual (degrees). Default 0.05. */
  maxResidual?: number;
  /** Fit is flagged if the horizontal part is inclined more than this (degrees). Default 5. */
  maxHorizontalSlope?: number;
}

export interface TracePoint {
  h: number;
  /** Cut-off V at this H; NaN where no cut-off was found. */
  v: number;
  gMax: number;
}

export interface CutoffFit {
  horizontal: {
    /** Mean cut-off V of the horizontal part. */
    meanV: number;
    /** Inclination of the horizontal part's fitted line (degrees). */
    slopeDeg: number;
    /** Straightness: largest and RMS deviation of its points from that line (degrees). */
    maxDev: number;
    rmsDev: number;
  };
  elbow: { h: number; v: number };
  /** Rise of the shoulder away from the horizontal part (degrees). */
  shoulderAngle: number;
  /** RMS deviation of all points from the two-segment fit (degrees). */
  residualRms: number;
}

export interface TraceResult {
  points: TracePoint[];
  fit: CutoffFit | null;
  poorFit: boolean;
  reason: string | null;
}

function solve3(a: number[][], b: number[]): number[] | null {
  const m = a.map((row, i) => [...row, b[i]!]);
  for (let c = 0; c < 3; c++) {
    let piv = c;
    for (let r = c + 1; r < 3; r++) if (Math.abs(m[r]![c]!) > Math.abs(m[piv]![c]!)) piv = r;
    if (Math.abs(m[piv]![c]!) < 1e-12) return null;
    [m[c], m[piv]] = [m[piv]!, m[c]!];
    for (let r = 0; r < 3; r++) {
      if (r === c) continue;
      const f = m[r]![c]! / m[c]![c]!;
      for (let k = c; k < 4; k++) m[r]![k]! -= f * m[c]![k]!;
    }
  }
  return [m[0]![3]! / m[0]![0]!, m[1]![3]! / m[1]![1]!, m[2]![3]! / m[2]![2]!];
}

/**
 * Continuous two-segment ("hinge") fit with a searched breakpoint b:
 *   RHT: V = α + β·H + γ·max(0, H − b)   (horizontal part left of b, shoulder to the right)
 *   LHT: V = α + β·H + γ·max(0, b − H)   (horizontal part right of b, shoulder to the left)
 * b is searched at 0.01° over positions leaving at least 3 points on each side.
 */
export function fitTwoSegments(
  points: TracePoint[],
  traffic: TrafficSide,
  opts: { maxResidual?: number; maxHorizontalSlope?: number } = {},
): { fit: CutoffFit | null; poorFit: boolean; reason: string | null } {
  const maxRes = opts.maxResidual ?? 0.05;
  const maxSlope = opts.maxHorizontalSlope ?? 5;
  const pts = points.filter((p) => Number.isFinite(p.v)).sort((a, b) => a.h - b.h);
  const MIN_SIDE = 3;
  if (pts.length < 2 * MIN_SIDE) {
    return { fit: null, poorFit: true, reason: `Only ${pts.length} points with a cut-off; at least ${2 * MIN_SIDE} are needed for a two-segment fit.` };
  }
  const hinge = (h: number, b: number) => (traffic === 'RHT' ? Math.max(0, h - b) : Math.max(0, b - h));
  let best: { sse: number; b: number; coef: number[] } | null = null;
  const lo = pts[MIN_SIDE - 1]!.h;
  const hi = pts[pts.length - MIN_SIDE]!.h;
  for (let b = lo; b <= hi + 1e-9; b += 0.01) {
    const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    const y = [0, 0, 0];
    for (const p of pts) {
      const x = [1, p.h, hinge(p.h, b)];
      for (let r = 0; r < 3; r++) {
        y[r]! += x[r]! * p.v;
        for (let c = 0; c < 3; c++) A[r]![c]! += x[r]! * x[c]!;
      }
    }
    const coef = solve3(A, y);
    if (!coef) continue;
    let sse = 0;
    for (const p of pts) sse += (p.v - (coef[0]! + coef[1]! * p.h + coef[2]! * hinge(p.h, b))) ** 2;
    if (!best || sse < best.sse) best = { sse, b, coef };
  }
  if (!best) return { fit: null, poorFit: true, reason: 'The two-segment fit could not be solved.' };
  const [alpha, beta, gamma] = best.coef as [number, number, number];
  const b = Number(best.b.toFixed(6));
  const residualRms = Math.sqrt(best.sse / pts.length);
  const R2D = 180 / Math.PI;
  const slopeDeg = Math.atan(beta) * R2D;
  if (residualRms > maxRes) {
    return {
      fit: null,
      poorFit: true,
      reason: `The two-segment fit is poor (RMS residual ${residualRms.toFixed(3)}° > ${maxRes}°): the cut-off may be stepped or Z-shaped. The raw trace is shown without a fit.`,
    };
  }
  if (Math.abs(slopeDeg) > maxSlope) {
    return {
      fit: null,
      poorFit: true,
      reason: `The part expected to be horizontal is inclined by ${slopeDeg.toFixed(1)}° (more than ${maxSlope}°): check the traffic side setting.`,
    };
  }
  const horizontalSide = pts.filter((p) => (traffic === 'RHT' ? p.h <= b : p.h >= b));
  const dev = horizontalSide.map((p) => p.v - (alpha + beta * p.h));
  const shoulderSlope = traffic === 'RHT' ? beta + gamma : gamma - beta;
  return {
    fit: {
      horizontal: {
        meanV: horizontalSide.reduce((s, p) => s + p.v, 0) / horizontalSide.length,
        slopeDeg,
        maxDev: Math.max(...dev.map(Math.abs)),
        rmsDev: Math.sqrt(dev.reduce((s, d) => s + d * d, 0) / dev.length),
      },
      elbow: { h: b, v: alpha + beta * b },
      shoulderAngle: Math.atan(shoulderSlope) * R2D,
      residualRms,
    },
    poorFit: false,
    reason: null,
  };
}

/** Scans every hStep across [hMin, hMax] and fits the cut-off line. */
export function traceCutoff(ds: PhotometricDataset, o: TraceOptions): TraceResult {
  const minG = o.minG ?? 0.05;
  const points: TracePoint[] = [];
  for (let k = 0; o.hMin + k * o.hStep <= o.hMax + 1e-9; k++) {
    const h = round9(o.hMin + k * o.hStep);
    const s = scanCutoff(ds, { h, vMin: o.vMin, vMax: o.vMax, ...(o.step ? { step: o.step } : {}) });
    points.push({ h, v: s.found && s.gMax >= minG ? s.v : NaN, gMax: s.gMax });
  }
  const f = fitTwoSegments(points, o.traffic, {
    ...(o.maxResidual !== undefined ? { maxResidual: o.maxResidual } : {}),
    ...(o.maxHorizontalSlope !== undefined ? { maxHorizontalSlope: o.maxHorizontalSlope } : {}),
  });
  return { points, ...f };
}

/** End points of the fitted horizontal part and shoulder, for drawing over [hMin, hMax]. */
export function fitSegments(fit: CutoffFit, traffic: TrafficSide, hMin: number, hMax: number): { horizontal: Array<[number, number]>; shoulder: Array<[number, number]> } {
  const D2R = Math.PI / 180;
  const { h: eh, v: ev } = fit.elbow;
  const hz = (h: number): [number, number] => [h, ev + Math.tan(fit.horizontal.slopeDeg * D2R) * (h - eh)];
  const sh = (h: number): [number, number] => [h, ev + Math.tan(fit.shoulderAngle * D2R) * (traffic === 'RHT' ? h - eh : eh - h)];
  return traffic === 'RHT'
    ? { horizontal: [hz(hMin), hz(eh)], shoulder: [sh(eh), sh(hMax)] }
    : { horizontal: [hz(eh), hz(hMax)], shoulder: [sh(hMin), sh(eh)] };
}
