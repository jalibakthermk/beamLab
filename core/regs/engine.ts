import type { Coverage, Grid, PhotometricDataset } from '../model/dataset';
import { ANGLE_EPS, sample } from '../geometry/interpolate';
import type { Limit, RegElement, Regulation, Units } from './schema';

/**
 * Generic regulation check engine (FRAMEWORK.md section 5.1).
 *
 * All limits come from the regulation file. Measured values are absolute cd
 * multiplied by the test conditions (scale factor × number of lamps). Anything
 * touching NaN or lying outside coverage is "not evaluated", never a pass.
 */

export type EngineErrorCode = 'NOT_INTENSITY' | 'MIRROR_NOT_ALLOWED' | 'BAD_CONDITIONS' | 'AIM_NOT_ALLOWED' | 'AIM_MISSING_VALUE';

export class EngineError extends Error {
  override name = 'EngineError';
  readonly code: EngineErrorCode;
  constructor(code: EngineErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface Conditions {
  /** 'RHT' (default): as written. 'LHT': elements mirrored in H (only if the file allows it). */
  traffic?: 'RHT' | 'LHT';
  /** Multiplies every measured value (e.g. measured vs nominal flux, test voltage). Default 1. */
  scaleFactor?: number;
  /** Number of lamps (measured values are multiplied by it). Default 1. */
  lamps?: number;
  /** Sampling step along lines, zone boundaries and search circles (degrees). Default 0.05. */
  step?: number;
}

/** What the engine samples: a dataset, or a rotated view of one during the re-aim search. */
export interface Field {
  value(h: number, v: number): number;
  grid: Grid;
  coverage: Coverage;
  /** Largest finite value and its position. */
  max(): { value: number; h: number; v: number };
}

export function datasetField(ds: PhotometricDataset): Field {
  let cached: { value: number; h: number; v: number } | null = null;
  return {
    value: (h, v) => sample(ds, h, v),
    grid: ds.grid,
    coverage: ds.coverage,
    max() {
      if (cached) return cached;
      let best = { value: NaN, h: NaN, v: NaN };
      const { h, v } = ds.grid;
      for (let iv = 0; iv < v.length; iv++) {
        for (let ih = 0; ih < h.length; ih++) {
          const x = ds.values[iv * h.length + ih]!;
          if (Number.isFinite(x) && !(x <= best.value)) best = { value: x, h: h[ih]!, v: v[iv]! };
        }
      }
      return (cached = best);
    },
  };
}

export type Status = 'pass' | 'fail' | 'not-evaluated';

export type Geometry =
  | { kind: 'point'; h: number; v: number; radius: number }
  | { kind: 'line'; from: [number, number]; to: [number, number] }
  | { kind: 'zone'; polygon: Array<[number, number]> }
  | { kind: 'none' };

export interface ElementResult {
  name: string;
  type: RegElement['type'];
  ref: string | null;
  status: Status;
  /** Why it was not evaluated. */
  reason: string | null;
  /** Measured value (cd × conditions; dimensionless for ratios), or null if it could not be measured. */
  measured: number | null;
  /** Resolved limits (cd; dimensionless for ratios). */
  limits: { min: number | null; max: number | null };
  /** The binding limit (the one with the smaller margin). */
  limit: { kind: 'min' | 'max'; value: number } | null;
  /** Distance to the binding limit: positive passes. */
  margin: number | null;
  /** margin / limit × 100. */
  marginPercent: number | null;
  /** Position of the measured (worst) value. */
  at: { h: number; v: number } | null;
  /** Element geometry as evaluated (after mirroring). */
  geometry: Geometry;
}

export interface RegulationResult {
  regulation: { id: string; title: string; source: string | null; revision: string | null; verified: boolean };
  conditions: { scaleFactor: number; lamps: number; factor: number; traffic: 'RHT' | 'LHT'; mirrored: boolean; units: Units };
  elements: ElementResult[];
  /** pass only if every element passed; incomplete if any was not evaluated; otherwise fail. */
  overall: 'pass' | 'fail' | 'incomplete';
  /** Element with the smallest margin in percent among the evaluated ones. */
  worst: string | null;
  counts: { pass: number; fail: number; notEvaluated: number };
}

const UNIT_FACTOR: Record<Units, number> = { cd: 1, 'lx@25m': 625 };

function pointInPolygon(h: number, v: number, poly: Array<[number, number]>): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [hi, vi] = poly[i]!;
    const [hj, vj] = poly[j]!;
    if (vi > v !== vj > v && h < ((hj - hi) * (v - vi)) / (vj - vi) + hi) inside = !inside;
  }
  return inside;
}

/** Points along a segment: both ends, every crossing of a grid line, and a fine step. */
function segmentSamples(a: [number, number], b: [number, number], grid: Grid, step: number): Array<[number, number]> {
  const ts = new Set<number>([0, 1]);
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const n = Math.max(1, Math.ceil(len / step));
  for (let k = 1; k < n; k++) ts.add(k / n);
  const cross = (axis: number[], a0: number, b0: number) => {
    if (b0 === a0) return;
    for (const g of axis) {
      const t = (g - a0) / (b0 - a0);
      if (t > 0 && t < 1) ts.add(t);
    }
  };
  cross(grid.h, a[0], b[0]);
  cross(grid.v, a[1], b[1]);
  return [...ts].sort((x, y) => x - y).map((t) => [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
}

interface Measure {
  ok: boolean;
  reason?: string;
  /** Worst / most favourable value per limit side, with positions. */
  low?: { value: number; h: number; v: number };
  high?: { value: number; h: number; v: number };
  geometry: Geometry;
}

/** Sample a set of positions; any NaN means "not evaluated". */
function extremes(field: Field, pts: Array<[number, number]>, what: string): Measure & { ok: boolean } {
  let low = { value: Infinity, h: NaN, v: NaN };
  let high = { value: -Infinity, h: NaN, v: NaN };
  for (const [h, v] of pts) {
    const x = field.value(h, v);
    if (!Number.isFinite(x)) return { ok: false, reason: `${what} reaches a direction with no data (outside coverage or NaN) at H ${round(h)}, V ${round(v)}`, geometry: { kind: 'none' } };
    if (x < low.value) low = { value: x, h, v };
    if (x > high.value) high = { value: x, h, v };
  }
  return { ok: true, low, high, geometry: { kind: 'none' } };
}

const round = (x: number) => Number(x.toFixed(4));
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

function measureGeometric(e: RegElement, field: Field, mirror: number, step: number): Measure {
  const m = (h: number) => (mirror < 0 && h !== 0 ? -h : h);
  switch (e.type) {
    case 'point': {
      if (!isNum(e.h) || !isNum(e.v)) return { ok: false, reason: 'position not supplied in the regulation file', geometry: { kind: 'none' } };
      const h0 = m(e.h);
      const r = e.searchRadius ?? 0;
      const geometry: Geometry = { kind: 'point', h: h0, v: e.v, radius: r };
      if (!(r > 0)) {
        const x = field.value(h0, e.v);
        if (!Number.isFinite(x)) return { ok: false, reason: `no data at H ${round(h0)}, V ${round(e.v)} (outside coverage or NaN)`, geometry };
        const p = { value: x, h: h0, v: e.v };
        return { ok: true, low: p, high: p, geometry };
      }
      // Search circle: centre, rings at the sampling step, and every data node inside
      const pts: Array<[number, number]> = [[h0, e.v]];
      for (let rr = step; rr < r + 1e-9; rr += step) {
        const ring = Math.min(rr, r);
        const n = Math.max(16, Math.ceil((2 * Math.PI * ring) / step));
        for (let k = 0; k < n; k++) pts.push([h0 + ring * Math.cos((2 * Math.PI * k) / n), e.v + ring * Math.sin((2 * Math.PI * k) / n)]);
      }
      const n = Math.max(360, Math.ceil((2 * Math.PI * r) / step));
      for (let k = 0; k < n; k++) pts.push([h0 + r * Math.cos((2 * Math.PI * k) / n), e.v + r * Math.sin((2 * Math.PI * k) / n)]);
      for (const gh of field.grid.h) for (const gv of field.grid.v) if (Math.hypot(gh - h0, gv - e.v) <= r) pts.push([gh, gv]);
      return { ...extremes(field, pts, 'The search circle'), geometry };
    }
    case 'line': {
      const [a, b] = [e.from, e.to];
      if (![a[0], a[1], b[0], b[1]].every(isNum)) return { ok: false, reason: 'end points not supplied in the regulation file', geometry: { kind: 'none' } };
      const from: [number, number] = [m(a[0] as number), a[1] as number];
      const to: [number, number] = [m(b[0] as number), b[1] as number];
      const geometry: Geometry = { kind: 'line', from, to };
      return { ...extremes(field, segmentSamples(from, to, field.grid, step), 'The line'), geometry };
    }
    case 'zone': {
      if (!e.polygon.every((q) => isNum(q[0]) && isNum(q[1]))) return { ok: false, reason: 'polygon vertices not supplied in the regulation file', geometry: { kind: 'none' } };
      const poly = e.polygon.map((q): [number, number] => [m(q[0] as number), q[1] as number]);
      const geometry: Geometry = { kind: 'zone', polygon: poly };
      const pts: Array<[number, number]> = [];
      for (let i = 0; i < poly.length; i++) pts.push(...segmentSamples(poly[i]!, poly[(i + 1) % poly.length]!, field.grid, step));
      const hs = poly.map((q) => q[0]);
      const vs = poly.map((q) => q[1]);
      const [hMin, hMax, vMin, vMax] = [Math.min(...hs), Math.max(...hs), Math.min(...vs), Math.max(...vs)];
      for (const gh of field.grid.h) {
        if (gh < hMin || gh > hMax) continue;
        for (const gv of field.grid.v) if (gv >= vMin && gv <= vMax && pointInPolygon(gh, gv, poly)) pts.push([gh, gv]);
      }
      // A zone extending beyond the data grid is partly outside coverage
      const c = field.coverage;
      if (hMin < c.hMin - ANGLE_EPS || hMax > c.hMax + ANGLE_EPS || vMin < c.vMin - ANGLE_EPS || vMax > c.vMax + ANGLE_EPS) {
        return { ok: false, reason: 'the zone extends outside the data coverage', geometry };
      }
      return { ...extremes(field, pts, 'The zone'), geometry };
    }
    case 'global': {
      const g = field.max();
      if (!Number.isFinite(g.value)) return { ok: false, reason: 'no data', geometry: { kind: 'none' } };
      return { ok: true, low: g, high: g, geometry: { kind: 'point', h: g.h, v: g.v, radius: 0 } };
    }
    case 'ratio':
      return { ok: false, geometry: { kind: 'none' } }; // handled separately
  }
}

/** Evaluate a regulation on a field (dataset or rotated view). */
export function evaluateField(field: Field, reg: Regulation, cond: Conditions = {}): RegulationResult {
  const scaleFactor = cond.scaleFactor ?? 1;
  const lamps = cond.lamps ?? 1;
  const traffic = cond.traffic ?? 'RHT';
  const step = cond.step ?? 0.05;
  if (!(scaleFactor > 0) || !Number.isFinite(scaleFactor)) throw new EngineError('BAD_CONDITIONS', `Scale factor must be a number > 0 (got ${scaleFactor}).`);
  if (!Number.isInteger(lamps) || lamps < 1) throw new EngineError('BAD_CONDITIONS', `Number of lamps must be a whole number ≥ 1 (got ${lamps}).`);
  if (traffic === 'LHT' && !reg.mirrorForLeftHandTraffic) {
    throw new EngineError('MIRROR_NOT_ALLOWED', `"${reg.title}" does not allow mirroring for left-hand traffic (mirrorForLeftHandTraffic is false).`);
  }
  const factor = scaleFactor * lamps;
  const unit = UNIT_FACTOR[reg.units];
  const mirror = traffic === 'LHT' ? -1 : 1;
  const results = new Map<string, ElementResult>();
  const byName = new Map(reg.elements.map((e) => [e.name, e] as const));
  const globalMax = field.max().value * factor;

  const resolveLimit = (lim: Limit | undefined, isRatio: boolean): { value: number | null; reason?: string } => {
    if (lim === undefined || lim === null) return { value: null };
    if (typeof lim === 'number') return { value: isRatio ? lim : lim * unit };
    if (lim.percent === null) return { value: null, reason: 'percentage not supplied' };
    const of = lim.of;
    if (of === 'max') return Number.isFinite(globalMax) ? { value: (lim.percent / 100) * globalMax } : { value: null, reason: 'maximum not measurable' };
    if ('parameter' in of) {
      const p = reg.parameters[of.parameter];
      return p === null || p === undefined ? { value: null, reason: `parameter "${of.parameter}" not supplied` } : { value: (lim.percent / 100) * p * (isRatio ? 1 : unit) };
    }
    // The reference only needs a measured value (it may itself have no limit)
    const ref = evaluate(of.element);
    return ref.measured !== null
      ? { value: (lim.percent / 100) * ref.measured }
      : { value: null, reason: `reference element "${of.element}" could not be measured` };
  };

  function evaluate(name: string): ElementResult {
    const done = results.get(name);
    if (done) return done;
    const e = byName.get(name)!;
    const base = { name: e.name, type: e.type, ref: e.ref ?? null };
    let measured: number | null = null;
    let at: { h: number; v: number } | null = null;
    let geometry: Geometry = { kind: 'none' };
    let low: number | null = null;
    let high: number | null = null;
    let lowAt: { h: number; v: number } | null = null;
    let highAt: { h: number; v: number } | null = null;
    let reason: string | null = null;

    if (e.type === 'ratio') {
      const a = evaluate(e.a);
      const b = evaluate(e.b);
      if (a.measured === null || b.measured === null || b.measured === 0) reason = `"${e.a}" or "${e.b}" could not be measured`;
      else low = high = measured = a.measured / b.measured;
    } else {
      const ms = measureGeometric(e, field, mirror, step);
      geometry = ms.geometry;
      if (!ms.ok) reason = ms.reason ?? 'could not be measured';
      else {
        low = ms.low!.value * factor;
        high = ms.high!.value * factor;
        lowAt = { h: round(ms.low!.h), v: round(ms.low!.v) };
        highAt = { h: round(ms.high!.h), v: round(ms.high!.v) };
      }
    }

    const isRatio = e.type === 'ratio';
    const rMin = resolveLimit(e.min, isRatio);
    const rMax = resolveLimit(e.max, isRatio);
    // For a min limit the most favourable / worst value is the lowest in a line or zone; for a point
    // with a search radius the most favourable is the highest. Max limits mirror that.
    const forMin = e.type === 'point' && (e.searchRadius ?? 0) > 0 ? { x: high, at: highAt } : { x: low, at: lowAt };
    const forMax = e.type === 'point' && (e.searchRadius ?? 0) > 0 ? { x: low, at: lowAt } : { x: high, at: highAt };
    const cands: Array<{ kind: 'min' | 'max'; value: number; margin: number; x: number; at: { h: number; v: number } | null }> = [];
    if (rMin.value !== null && forMin.x !== null) cands.push({ kind: 'min', value: rMin.value, margin: forMin.x - rMin.value, x: forMin.x, at: forMin.at });
    if (rMax.value !== null && forMax.x !== null) cands.push({ kind: 'max', value: rMax.value, margin: rMax.value - forMax.x, x: forMax.x, at: forMax.at });
    const pct = (c: (typeof cands)[number]) => (c.value !== 0 ? (100 * c.margin) / Math.abs(c.value) : c.margin >= 0 ? Infinity : -Infinity);
    const binding = cands.sort((p, q) => pct(p) - pct(q))[0];

    // Measured value shown: the binding side, or the natural value when there is no limit
    if (binding) {
      measured = binding.x;
      at = binding.at;
    } else if (reason === null) {
      measured = isRatio ? measured : (e.type === 'zone' || e.type === 'line' ? high : low);
      at = isRatio ? null : (e.type === 'zone' || e.type === 'line' ? highAt : lowAt);
    }
    let status: Status;
    if (reason !== null) status = 'not-evaluated';
    else if (!binding) {
      status = 'not-evaluated';
      reason = rMin.reason ?? rMax.reason ?? 'no limit supplied (value reported only)';
      if (rMin.reason || rMax.reason) reason = `limit could not be resolved: ${rMin.reason ?? rMax.reason}`;
    } else status = binding.margin >= 0 ? 'pass' : 'fail';

    const r: ElementResult = {
      ...base,
      status,
      reason,
      measured,
      limits: { min: rMin.value, max: rMax.value },
      limit: binding ? { kind: binding.kind, value: binding.value } : null,
      margin: binding && status !== 'not-evaluated' ? binding.margin : null,
      marginPercent: binding && status !== 'not-evaluated' ? pct(binding) : null,
      at,
      geometry,
    };
    results.set(name, r);
    return r;
  }

  const elements = reg.elements.map((e) => evaluate(e.name));
  const counts = { pass: 0, fail: 0, notEvaluated: 0 };
  for (const e of elements) {
    if (e.status === 'pass') counts.pass++;
    else if (e.status === 'fail') counts.fail++;
    else counts.notEvaluated++;
  }
  const evaluated = elements.filter((e) => e.marginPercent !== null);
  const worst = evaluated.length ? evaluated.reduce((a, b) => (b.marginPercent! < a.marginPercent! ? b : a)).name : null;
  return {
    regulation: { id: reg.id, title: reg.title, source: reg.source, revision: reg.revision, verified: reg.verified },
    conditions: { scaleFactor, lamps, factor, traffic, mirrored: mirror < 0, units: reg.units },
    elements,
    overall: counts.notEvaluated > 0 ? 'incomplete' : counts.fail > 0 ? 'fail' : 'pass',
    worst,
    counts,
  };
}

/** Evaluate a regulation on an intensity dataset. */
export function evaluateRegulation(ds: PhotometricDataset, reg: Regulation, cond: Conditions = {}): RegulationResult {
  if (ds.kind !== 'intensity') throw new EngineError('NOT_INTENSITY', `Regulation checks need an intensity dataset; "${ds.name}" is ${ds.kind}.`);
  return evaluateField(datasetField(ds), reg, cond);
}

// ── Outputs ──────────────────────────────────────────────────────────────

const csvNum = (x: number | null) => (x === null || !Number.isFinite(x) ? '' : String(Number(x.toPrecision(10))));
const csvPct = (x: number | null) => (x === null || !Number.isFinite(x) ? '' : String(Number(x.toFixed(6))));
const csvText = (s: string | null) => (s === null ? '' : /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/** The results table as CSV (values in cd, ratios dimensionless). */
export function resultsToCsv(r: RegulationResult): string {
  const rows = ['element,type,status,measured,limit_kind,limit,margin,margin_percent,H,V,reference,reason'];
  for (const e of r.elements) {
    rows.push(
      [
        csvText(e.name), e.type, e.status, csvNum(e.measured), e.limit?.kind ?? '', csvNum(e.limit?.value ?? null),
        csvNum(e.margin), csvPct(e.marginPercent), csvNum(e.at?.h ?? null), csvNum(e.at?.v ?? null), csvText(e.ref), csvText(e.reason),
      ].join(','),
    );
  }
  return rows.join('\n') + '\n';
}

function distToSegment(h: number, v: number, a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((h - a[0]) * dx + (v - a[1]) * dy) / l2));
  return Math.hypot(h - (a[0] + t * dx), v - (a[1] + t * dy));
}

/** Element under the pointer: nearest point or line within tol (degrees), else a zone containing it. */
export function nearestElement(r: RegulationResult, h: number, v: number, tol: number): string | null {
  let best: { name: string; d: number } | null = null;
  for (const e of r.elements) {
    const g = e.geometry;
    let d = Infinity;
    if (g.kind === 'point') d = Math.max(0, Math.hypot(h - g.h, v - g.v));
    else if (g.kind === 'line') d = distToSegment(h, v, g.from, g.to);
    if (d <= tol && (!best || d < best.d)) best = { name: e.name, d };
  }
  if (best) return best.name;
  for (const e of r.elements) if (e.geometry.kind === 'zone' && pointInPolygon(h, v, e.geometry.polygon)) return e.name;
  return null;
}


/** Polyline for drawing an element (closed for zones and search circles); points with no radius give one point. */
export function geometryOutline(g: Geometry, segments = 72): { h: number[]; v: number[] } {
  switch (g.kind) {
    case 'point': {
      if (!(g.radius > 0)) return { h: [g.h], v: [g.v] };
      const h: number[] = [];
      const v: number[] = [];
      for (let k = 0; k <= segments; k++) {
        h.push(g.h + g.radius * Math.cos((2 * Math.PI * k) / segments));
        v.push(g.v + g.radius * Math.sin((2 * Math.PI * k) / segments));
      }
      return { h, v };
    }
    case 'line':
      return { h: [g.from[0], g.to[0]], v: [g.from[1], g.to[1]] };
    case 'zone':
      return { h: [...g.polygon.map((q) => q[0]), g.polygon[0]![0]], v: [...g.polygon.map((q) => q[1]), g.polygon[0]![1]] };
    case 'none':
      return { h: [], v: [] };
  }
}
