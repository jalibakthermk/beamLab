import type { Vec3 } from '../geometry/coords';
import { axisValues, makeEvaluator, roadIlluminance, type IlluminanceField, type OutsidePolicy, type RoadGrid, type RoadLamp } from './illuminance';
import { checkLevels, fieldMax, pointValues, reach, width, type ReachResult, type RoadPoint, type WidthResult } from './metrics';
import { evaluateRequirements, requirementsToCsv, type RequirementsResult, type RoadRequirements } from './requirements';
import type { LineName, RoadLayout } from './setup';

/**
 * One complete road calculation (Phase 7): the road grid, reach of every isolux
 * level on the lane lines, widths, point values, maximum and the requirements
 * check. Inputs and outputs are plain data, so this can run in a Web Worker.
 */

export interface RoadRunInput {
  lamps: RoadLamp[];
  grid: RoadGrid;
  outside: OutsidePolicy;
  /** Isolux levels, lx (may be empty: no reach rows). */
  levels: number[];
  /** Lane layout; null until the lane setup is entered (reach then only on the vehicle axis). */
  layout: RoadLayout | null;
  /** Distances (m) for the beam width, and the level (lx) it is measured at. */
  widthDistances: number[];
  widthLevel: number | null;
  points: RoadPoint[];
  requirements: RoadRequirements | null;
  maxPoints?: number;
}

export interface RoadRunResult {
  field: IlluminanceField;
  max: { value: number; x: number; y: number } | null;
  reaches: Array<ReachResult & { line: LineName }>;
  widths: WidthResult[];
  points: Array<RoadPoint & { value: number }>;
  requirements: RequirementsResult | null;
  /** Calculation time, ms. */
  ms: number;
}

const LINE_LABEL: Record<LineName, string> = {
  'vehicle-axis': 'vehicle axis',
  'lane-centre': 'lane centre',
  'lane-left-edge': 'lane left edge',
  'lane-right-edge': 'lane right edge',
};
export const lineLabel = (l: LineName) => LINE_LABEL[l];

export function runRoad(input: RoadRunInput, now: () => number = () => Date.now()): RoadRunResult {
  const t0 = now();
  const levels = input.levels.length ? checkLevels(input.levels) : [];
  const field = roadIlluminance(input.lamps, input.grid, { outside: input.outside, ...(input.maxPoints ? { maxPoints: input.maxPoints } : {}) });
  const evaluate = makeEvaluator(input.lamps, { outside: input.outside });
  const xs = axisValues(input.grid.x, 'x');
  const ys = axisValues(input.grid.y, 'y');
  const lines: Partial<Record<LineName, number>> = input.layout ? input.layout.lines : { 'vehicle-axis': 0 };
  const shown: LineName[] = input.layout ? ['lane-centre', 'lane-left-edge', 'lane-right-edge'] : ['vehicle-axis'];
  const reaches = levels.flatMap((level) => shown.map((line) => ({ line, ...reach(evaluate, lines[line]!, xs, level) })));
  const widths = input.widthLevel !== null && input.widthLevel > 0 ? input.widthDistances.map((x) => width(evaluate, x, ys, input.widthLevel!)) : [];
  const points = pointValues(evaluate, input.points);
  const requirements = input.requirements
    ? evaluateRequirements(input.requirements, { evaluate, lines, reachX: input.grid.x, widthY: input.grid.y })
    : null;
  const m = fieldMax(field);
  return { field, max: m ? { value: m.value, x: m.col, y: m.row } : null, reaches, widths, points, requirements, ms: now() - t0 };
}

const n = (x: number | null | undefined, digits = 4) => (x === null || x === undefined || !Number.isFinite(x) ? '' : String(Number(x.toPrecision(digits + 4))));
const t = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
const planeText = (nrm: Vec3 | undefined) => (!nrm || (nrm[0] === 0 && nrm[1] === 0 && nrm[2] === 1) ? 'road' : nrm[0] === -1 && nrm[1] === 0 && nrm[2] === 0 ? 'vertical' : `normal ${nrm.join(' ')}`);

/** Results as CSV: sections for setup, reach, width, points, maximum and requirements. */
export function roadResultsToCsv(input: RoadRunInput, r: RoadRunResult): string {
  const out: string[] = [];
  out.push('# beamLab road results; units m and lx; vehicle frame x forward, y right, z up');
  out.push('section,lamp,dataset,mirror,x,y,height,yaw,pitch,roll');
  input.lamps.forEach((l, i) => out.push(['lamp', t(l.name ?? `lamp ${i + 1}`), t(l.dataset.name), l.mirror ? 'yes' : 'no', n(l.position.x), n(l.position.y), n(l.position.height), n(l.aim.yaw), n(l.aim.pitch), n(l.aim.roll)].join(',')));
  out.push(`grid,x ${input.grid.x.min}..${input.grid.x.max} step ${input.grid.x.step},y ${input.grid.y.min}..${input.grid.y.max} step ${input.grid.y.step},outside ${input.outside},unknown share ${n(r.field.unknownFraction)}`);
  out.push('');
  out.push('section,line,y,level_lx,reach_m,crossings_m,multiple_crossings,beyond_end,unknown_beyond');
  for (const x of r.reaches) out.push(['reach', lineLabel(x.line), n(x.y), n(x.level), n(x.reach), t(x.crossings.map((c) => `${c.direction} ${n(c.at)}`).join('; ')), x.multiple ? 'yes' : 'no', x.beyondEnd ? 'yes' : 'no', x.unknownBeyond ? 'yes' : 'no'].join(','));
  out.push('');
  out.push('section,x_m,level_lx,from_y_m,to_y_m,width_m,separate_areas,clipped,unknown_adjacent');
  for (const w of r.widths) out.push(['width', n(w.x), n(w.level), n(w.from), n(w.to), n(w.width), w.multiple ? 'yes' : 'no', w.clipped ? 'yes' : 'no', w.unknownAdjacent ? 'yes' : 'no'].join(','));
  out.push('');
  out.push('section,name,x_m,y_m,z_m,plane,E_lx');
  for (const p of r.points) out.push(['point', t(p.name), n(p.point[0]), n(p.point[1]), n(p.point[2]), t(planeText(p.normal)), Number.isNaN(p.value) ? 'unknown' : n(p.value)].join(','));
  out.push('');
  out.push(`maximum,${r.max ? `${n(r.max.value)} lx at x ${n(r.max.x)} m y ${n(r.max.y)} m` : 'none'}`);
  if (r.requirements) {
    out.push('');
    out.push(`# requirements: ${t(r.requirements.requirements.title)}${r.requirements.requirements.verified ? '' : ' (unverified)'}; overall ${r.requirements.overall}`);
    out.push(requirementsToCsv(r.requirements).trimEnd());
  }
  return out.join('\n') + '\n';
}
