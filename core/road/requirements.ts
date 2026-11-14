import type { Vec3 } from '../geometry/coords';
import { FACING_VEHICLE, ROAD_NORMAL, axisValues, type AxisRange } from './illuminance';
import { reach, width, type Crossing, type Evaluate } from './metrics';
import { LINE_NAMES, type LineName } from './setup';

/**
 * Road requirements (Phase 7): customer specifications in road coordinates,
 * same approach as the regulation engine (core/regs). Files live in
 * data/requirements/. Every numeric value comes from the file; unknown values
 * are null and give "not evaluated". Unknown areas never count as a pass.
 *
 * Elements:
 *   point  E at (x, y, z) on a plane: "road", "vertical" (facing the vehicle) or { normal }; min and/or max lx.
 *   reach  furthest distance (m) at which E ≥ level on a named line; min and/or max m.
 *   width  width (m) of the area E ≥ level across the road at distance x; min and/or max m.
 */

export type PlaneSpec = 'road' | 'vertical' | { normal: [number, number, number] };

interface Base {
  name: string;
  ref?: string | null;
  min?: number | null;
  max?: number | null;
}
export interface PointRequirement extends Base {
  type: 'point';
  x: number | null;
  y: number | null;
  z: number | null;
  plane: PlaneSpec;
}
export interface ReachRequirement extends Base {
  type: 'reach';
  line: LineName;
  level: number | null;
}
export interface WidthRequirement extends Base {
  type: 'width';
  x: number | null;
  level: number | null;
}
export type RoadRequirement = PointRequirement | ReachRequirement | WidthRequirement;

export interface RoadRequirements {
  id: string;
  title: string;
  source: string | null;
  revision: string | null;
  verified: boolean;
  elements: RoadRequirement[];
  notes?: string;
}

export class RequirementsError extends Error {
  override name = 'RequirementsError';
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`Invalid requirements file:\n- ${problems.join('\n- ')}`);
    this.problems = problems;
  }
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isNumOrNull = (x: unknown) => x === null || (typeof x === 'number' && Number.isFinite(x));
const TYPES = ['point', 'reach', 'width'];

/** Validates a requirements object. Throws RequirementsError listing every problem with its path. */
export function parseRequirements(obj: unknown): RoadRequirements {
  const p: string[] = [];
  if (!isObj(obj)) throw new RequirementsError(['(root): must be an object']);
  for (const k of ['id', 'title']) if (typeof obj[k] !== 'string') p.push(`${k}: must be a string`);
  for (const k of ['source', 'revision']) if (obj[k] !== undefined && obj[k] !== null && typeof obj[k] !== 'string') p.push(`${k}: must be a string or null`);
  if (typeof obj['verified'] !== 'boolean') p.push('verified: must be true or false');
  const els = obj['elements'];
  if (!Array.isArray(els)) p.push('elements: must be a list');
  const names = new Set<string>();
  (Array.isArray(els) ? els : []).forEach((e, i) => {
    const at = `elements[${i}]`;
    if (!isObj(e)) return p.push(`${at}: must be an object`);
    if (!TYPES.includes(e['type'] as string)) return p.push(`${at}.type: must be one of ${TYPES.join(', ')}`);
    if (typeof e['name'] !== 'string' || !e['name']) p.push(`${at}.name: must be a non-empty string`);
    else if (names.has(e['name'])) p.push(`${at}.name: duplicate name "${e['name']}"`);
    else names.add(e['name']);
    if (e['ref'] !== undefined && e['ref'] !== null && typeof e['ref'] !== 'string') p.push(`${at}.ref: must be a string or null`);
    for (const k of ['min', 'max']) if (e[k] !== undefined && !isNumOrNull(e[k])) p.push(`${at}.${k}: must be a number or null`);
    const nums = e['type'] === 'point' ? ['x', 'y', 'z'] : e['type'] === 'reach' ? ['level'] : ['x', 'level'];
    for (const k of nums) if (!isNumOrNull(e[k])) p.push(`${at}.${k}: must be a number or null`);
    if (e['type'] === 'point') {
      const pl = e['plane'];
      const ok = pl === 'road' || pl === 'vertical' || (isObj(pl) && Array.isArray(pl['normal']) && pl['normal'].length === 3 && pl['normal'].every((x) => typeof x === 'number' && Number.isFinite(x)) && pl['normal'].some((x) => x !== 0));
      if (!ok) p.push(`${at}.plane: must be "road", "vertical" or { "normal": [nx, ny, nz] }`);
    }
    if (e['type'] === 'reach' && !LINE_NAMES.includes(e['line'] as LineName)) p.push(`${at}.line: must be one of ${LINE_NAMES.join(', ')}`);
  });
  if (p.length) throw new RequirementsError(p);
  return obj as unknown as RoadRequirements;
}

// ── Evaluation ───────────────────────────────────────────────────────────

export type Status = 'pass' | 'fail' | 'not-evaluated';

export interface RequirementContext {
  evaluate: Evaluate;
  /** y of each named line (from laneLayout); lane lines are missing until the lane setup is entered. */
  lines: Partial<Record<LineName, number>>;
  /** Positions along x at which reach is evaluated. */
  reachX: AxisRange;
  /** Positions across y at which width is evaluated. */
  widthY: AxisRange;
}

export interface RequirementResult {
  name: string;
  type: RoadRequirement['type'];
  ref: string | null;
  status: Status;
  reason: string | null;
  /** lx (point) or m (reach, width); null if it could not be measured. */
  measured: number | null;
  unit: 'lx' | 'm';
  limit: { kind: 'min' | 'max'; value: number } | null;
  margin: number | null;
  marginPercent: number | null;
  flags: string[];
  /** Reach only: every crossing of the level along the line. */
  crossings?: Crossing[];
  /** Width only: the area's extent across the road. */
  extent?: { from: number; to: number; segments: Array<[number, number]> };
  /** Where it was evaluated (m). */
  at: { x: number; y: number; z: number } | { y: number } | { x: number } | null;
}

export interface RequirementsResult {
  requirements: { id: string; title: string; source: string | null; revision: string | null; verified: boolean };
  elements: RequirementResult[];
  overall: 'pass' | 'fail' | 'incomplete';
  worst: string | null;
  counts: { pass: number; fail: number; notEvaluated: number };
}

const num = (x: number | null | undefined): x is number => typeof x === 'number' && Number.isFinite(x);

function normalOf(pl: PlaneSpec): Vec3 {
  return pl === 'road' ? ROAD_NORMAL : pl === 'vertical' ? FACING_VEHICLE : pl.normal;
}

interface Outcome {
  measured: number | null;
  /** May the measured value be an underestimate (true value could be larger)? */
  couldBeLarger: boolean;
  /** Could it be smaller? */
  couldBeSmaller: boolean;
  unknownReason: string | null;
  flags: string[];
}

/** Status from a measured value and limits. Uncertain directions never give a pass. */
function judge(o: Outcome, min: number | null, max: number | null) {
  type Cand = { kind: 'min' | 'max'; value: number; margin: number };
  const cands: Cand[] = [];
  if (o.measured !== null) {
    if (min !== null) cands.push({ kind: 'min', value: min, margin: o.measured - min });
    if (max !== null) cands.push({ kind: 'max', value: max, margin: max - o.measured });
  }
  const pct = (c: Cand) => (c.value !== 0 ? (100 * c.margin) / Math.abs(c.value) : c.margin >= 0 ? Infinity : -Infinity);
  let status: Status;
  let reason: string | null = null;
  if (o.measured === null) {
    status = 'not-evaluated';
    reason = o.unknownReason;
  } else {
    // A limit is decided only if the uncertainty cannot change its outcome.
    const decided = cands.map((c) => {
      const pass = c.margin >= 0;
      const upCanChange = c.kind === 'min' ? !pass : pass;
      return { pass, uncertain: (o.couldBeLarger && upCanChange) || (o.couldBeSmaller && !upCanChange) };
    });
    if (decided.some((d) => !d.pass && !d.uncertain)) status = 'fail';
    else if (decided.some((d) => d.uncertain)) {
      status = 'not-evaluated';
      reason = o.unknownReason;
    } else status = 'pass';
  }
  const binding = cands.length ? cands.reduce((a, b) => (pct(b) < pct(a) ? b : a)) : null;
  const evaluated = status !== 'not-evaluated' && binding !== null;
  return {
    status,
    reason,
    limit: binding ? { kind: binding.kind, value: binding.value } : null,
    margin: evaluated ? binding!.margin : null,
    marginPercent: evaluated ? pct(binding!) : null,
  };
}

export function evaluateRequirements(req: RoadRequirements, ctx: RequirementContext): RequirementsResult {
  const xs = axisValues(ctx.reachX, 'reach x');
  const ys = axisValues(ctx.widthY, 'width y');
  const elements = req.elements.map((e): RequirementResult => {
    const min = num(e.min) ? e.min : null;
    const max = num(e.max) ? e.max : null;
    const base = { name: e.name, type: e.type, ref: e.ref ?? null, unit: (e.type === 'point' ? 'lx' : 'm') as 'lx' | 'm' };
    const missing = (reason: string): RequirementResult => ({ ...base, status: 'not-evaluated', reason, measured: null, limit: null, margin: null, marginPercent: null, flags: [], at: null });
    if (min === null && max === null) return missing('no limit in the requirement file (min and max are null)');

    let o: Outcome;
    let extra: Partial<RequirementResult> = {};
    if (e.type === 'point') {
      if (!num(e.x) || !num(e.y) || !num(e.z)) return missing('position missing in the requirement file');
      const v = ctx.evaluate([e.x, e.y, e.z], normalOf(e.plane));
      o = Number.isNaN(v)
        ? { measured: null, couldBeLarger: true, couldBeSmaller: true, unknownReason: 'a lamp has no data in the direction of this point (unknown)', flags: [] }
        : { measured: v, couldBeLarger: false, couldBeSmaller: false, unknownReason: null, flags: [] };
      extra = { at: { x: e.x, y: e.y, z: e.z } };
    } else if (e.type === 'reach') {
      if (!num(e.level)) return missing('level missing in the requirement file');
      const y = ctx.lines[e.line];
      if (y === undefined || !Number.isFinite(y)) return missing(`line ${e.line} is not defined: enter the lane setup`);
      const r = reach(ctx.evaluate, y, xs, e.level);
      const flags: string[] = [];
      if (r.reach === null) flags.push('level not reached');
      if (r.multiple) flags.push('multiple crossings');
      if (r.beyondEnd) flags.push('reaches the end of the evaluated range');
      if (r.unknownCount) flags.push('unknown areas on the line');
      const unknownBeyond = r.unknownBeyond;
      o = {
        // Not reached on known data counts as a reach of 0 m.
        measured: r.reach ?? 0,
        couldBeLarger: r.beyondEnd || unknownBeyond,
        couldBeSmaller: false,
        unknownReason: r.beyondEnd ? 'the level is still reached at the end of the evaluated range' : unknownBeyond ? 'unknown areas on the line beyond the reach' : null,
        flags,
      };
      extra = { crossings: r.crossings, at: { y } };
    } else {
      if (!num(e.x) || !num(e.level)) return missing('distance or level missing in the requirement file');
      const w = width(ctx.evaluate, e.x, ys, e.level);
      const flags: string[] = [];
      if (w.width === null) flags.push('level not reached');
      if (w.multiple) flags.push('separate areas above the level');
      if (w.clipped) flags.push('reaches the end of the evaluated range');
      if (w.unknownAdjacent) flags.push('runs into unknown areas');
      else if (w.unknownCount) flags.push('unknown areas across the road');
      // With no area found, unknown samples anywhere could hide one.
      const unknown = w.unknownAdjacent || (w.width === null && w.unknownCount > 0);
      o = {
        measured: w.width ?? 0,
        couldBeLarger: w.clipped || unknown,
        couldBeSmaller: false,
        unknownReason: unknown ? 'the area runs into unknown areas' : w.clipped ? 'the area reaches the end of the evaluated range' : null,
        flags,
      };
      extra = { at: { x: e.x }, ...(w.from !== null && w.to !== null ? { extent: { from: w.from, to: w.to, segments: w.segments } } : {}) };
    }
    const j = judge(o, min, max);
    return { ...base, ...j, measured: o.measured, flags: o.flags, at: null, ...extra } as RequirementResult;
  });

  const counts = { pass: 0, fail: 0, notEvaluated: 0 };
  for (const e of elements) {
    if (e.status === 'pass') counts.pass++;
    else if (e.status === 'fail') counts.fail++;
    else counts.notEvaluated++;
  }
  const evaluated = elements.filter((e) => e.marginPercent !== null);
  const worst = evaluated.length ? evaluated.reduce((a, b) => (b.marginPercent! < a.marginPercent! ? b : a)).name : null;
  return {
    requirements: { id: req.id, title: req.title, source: req.source ?? null, revision: req.revision ?? null, verified: req.verified },
    elements,
    overall: counts.notEvaluated > 0 ? 'incomplete' : counts.fail > 0 ? 'fail' : 'pass',
    worst,
    counts,
  };
}

const csvNum = (x: number | null) => (x === null || !Number.isFinite(x) ? '' : String(Number(x.toPrecision(10))));
const csvText = (s: string | null) => (s === null ? '' : /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

export function requirementsToCsv(r: RequirementsResult): string {
  const rows = ['element,type,status,measured,unit,limit_kind,limit,margin,margin_percent,flags,reference,reason'];
  for (const e of r.elements) {
    rows.push(
      [
        csvText(e.name), e.type, e.status, csvNum(e.measured), e.unit, e.limit?.kind ?? '', csvNum(e.limit?.value ?? null),
        csvNum(e.margin), e.marginPercent === null || !Number.isFinite(e.marginPercent) ? '' : String(Number(e.marginPercent.toFixed(6))),
        csvText(e.flags.join('; ') || null), csvText(e.ref), csvText(e.reason),
      ].join(','),
    );
  }
  return rows.join('\n') + '\n';
}
