/**
 * Regulation file schema and a hand-written validator (FRAMEWORK.md section 5.1).
 *
 * Every numeric value comes from the regulation file; unknown values are null.
 * A limit is an absolute value (in the file's units), null, or a percentage of
 * a reference: { "percent": p, "of": "max" | { "element": name } | { "parameter": name } }.
 */

export type Units = 'cd' | 'lx@25m';
export type AimMode = 'as-loaded' | 'aim-to-cutoff' | 're-aim-search';
export const AIM_MODES: AimMode[] = ['as-loaded', 'aim-to-cutoff', 're-aim-search'];
export const ELEMENT_TYPES = ['point', 'line', 'zone', 'ratio', 'global'] as const;

export type LimitRef = 'max' | { element: string } | { parameter: string };
export type Limit = number | null | { percent: number | null; of: LimitRef };

interface Base {
  name: string;
  /** Source reference for this element (table or paragraph). */
  ref?: string;
  min?: Limit;
  max?: Limit;
}
export interface PointElement extends Base {
  type: 'point';
  h: number | null;
  v: number | null;
  /** If set, the most favourable value within this radius (degrees) counts. */
  searchRadius?: number | null;
}
export interface LineElement extends Base {
  type: 'line';
  from: [number | null, number | null];
  to: [number | null, number | null];
}
export interface ZoneElement extends Base {
  type: 'zone';
  /** Polygon in H-V (degrees). max: "max anywhere" ≤ limit; min: "min anywhere" ≥ limit. */
  polygon: Array<[number | null, number | null]>;
}
export interface RatioElement extends Base {
  type: 'ratio';
  a: string;
  b: string;
}
export interface GlobalElement extends Base {
  type: 'global';
}
export type RegElement = PointElement | LineElement | ZoneElement | RatioElement | GlobalElement;

export interface Regulation {
  id: string;
  title: string;
  source: string | null;
  revision: string | null;
  /** False until every value has been checked against the official text. */
  verified: boolean;
  /** 'lx@25m' values are converted with cd = lx × 625. */
  units: Units;
  /** The file is written for right-hand traffic; mirroring in H for left-hand traffic is allowed only if true. */
  mirrorForLeftHandTraffic: boolean;
  /** Named parameters that percentage limits can refer to (file units). */
  parameters: Record<string, number | null>;
  aim: {
    modes: AimMode[];
    nominalCutoffV: number | null;
    /** Permitted re-aim range: ± degrees in H and V. */
    reaim: { h: number | null; v: number | null };
  };
  elements: RegElement[];
  notes?: string;
}

export class RegulationError extends Error {
  override name = 'RegulationError';
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`Invalid regulation file:\n- ${problems.join('\n- ')}`);
    this.problems = problems;
  }
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isNumOrNull = (x: unknown) => x === null || (typeof x === 'number' && Number.isFinite(x));

/** Validates a regulation object and returns it typed. Throws RegulationError listing every problem with its path. */
export function parseRegulation(obj: unknown): Regulation {
  const p: string[] = [];
  if (!isObj(obj)) throw new RegulationError(['(root): must be an object']);
  const o = obj;
  const str = (k: string, nullable: boolean) => {
    if (!(typeof o[k] === 'string' || (nullable && o[k] === null))) p.push(`${k}: must be a string${nullable ? ' or null' : ''}`);
  };
  str('id', false);
  str('title', false);
  str('source', true);
  str('revision', true);
  if (o['verified'] !== undefined && typeof o['verified'] !== 'boolean') p.push('verified: must be true or false');
  if (o['units'] !== 'cd' && o['units'] !== 'lx@25m') p.push('units: must be "cd" or "lx@25m"');
  if (typeof o['mirrorForLeftHandTraffic'] !== 'boolean') p.push('mirrorForLeftHandTraffic: must be true or false');

  const params = o['parameters'] ?? {};
  if (!isObj(params)) p.push('parameters: must be an object of name → number or null');
  else for (const [k, x] of Object.entries(params)) if (!isNumOrNull(x)) p.push(`parameters.${k}: must be a number or null`);
  const paramNames = new Set(isObj(params) ? Object.keys(params) : []);

  const aim = o['aim'];
  if (!isObj(aim)) p.push('aim: must be an object with modes, nominalCutoffV and reaim');
  else {
    if (!Array.isArray(aim['modes'])) p.push('aim.modes: must be a list');
    else aim['modes'].forEach((m, i) => !AIM_MODES.includes(m as AimMode) && p.push(`aim.modes[${i}]: must be one of ${AIM_MODES.join(', ')}`));
    if (!isNumOrNull(aim['nominalCutoffV'])) p.push('aim.nominalCutoffV: must be a number or null');
    const r = aim['reaim'];
    if (!isObj(r)) p.push('aim.reaim: must be an object with h and v');
    else for (const k of ['h', 'v']) if (!isNumOrNull(r[k])) p.push(`aim.reaim.${k}: must be a number or null`);
  }

  const els = o['elements'];
  if (!Array.isArray(els)) p.push('elements: must be a list');
  const list = Array.isArray(els) ? els : [];
  const names = list.map((e) => (isObj(e) && typeof e['name'] === 'string' ? e['name'] : null));
  const nameSet = new Set<string>();
  const percentEdges: Array<[string, string]> = [];

  list.forEach((e, i) => {
    const label = `elements[${i}]${names[i] ? ` (${names[i]})` : ''}`;
    if (!isObj(e)) {
      p.push(`${label}: must be an object`);
      return;
    }
    if (typeof e['name'] !== 'string' || !e['name']) p.push(`${label}.name: must be a non-empty string`);
    else if (nameSet.has(e['name'])) p.push(`${label}.name: duplicate element name "${e['name']}"`);
    else nameSet.add(e['name']);
    if (e['ref'] !== undefined && typeof e['ref'] !== 'string') p.push(`${label}.ref: must be a string`);
    const type = e['type'];
    if (!ELEMENT_TYPES.includes(type as (typeof ELEMENT_TYPES)[number])) p.push(`${label}.type: must be one of ${ELEMENT_TYPES.join(', ')}`);
    const hv = (k: string) => {
      const x = e[k];
      if (!Array.isArray(x) || x.length !== 2 || !x.every(isNumOrNull)) p.push(`${label}.${k}: must be [H, V] (numbers or null)`);
    };
    if (type === 'point') {
      for (const k of ['h', 'v']) if (!isNumOrNull(e[k])) p.push(`${label}.${k}: must be a number or null`);
      if (e['searchRadius'] !== undefined && !(isNumOrNull(e['searchRadius']) && (e['searchRadius'] === null || (e['searchRadius'] as number) >= 0))) {
        p.push(`${label}.searchRadius: must be a number ≥ 0 or null`);
      }
    } else if (type === 'line') {
      hv('from');
      hv('to');
    } else if (type === 'zone') {
      const poly = e['polygon'];
      if (!Array.isArray(poly) || poly.length < 3) p.push(`${label}.polygon: needs at least 3 vertices [H, V]`);
      else poly.forEach((q, j) => (!Array.isArray(q) || q.length !== 2 || !q.every(isNumOrNull)) && p.push(`${label}.polygon[${j}]: must be [H, V]`));
    } else if (type === 'ratio') {
      for (const k of ['a', 'b']) {
        const x = e[k];
        if (typeof x !== 'string') p.push(`${label}.${k}: must be an element name`);
        else if (!names.includes(x)) p.push(`${label}.${k}: refers to unknown element "${x}"`);
      }
    }
    for (const k of ['min', 'max']) {
      const lim = e[k];
      if (lim === undefined || isNumOrNull(lim)) continue;
      if (!isObj(lim) || !('percent' in lim) || !('of' in lim)) {
        p.push(`${label}.${k}: must be a number, null, or { "percent", "of" }`);
        continue;
      }
      if (!isNumOrNull(lim['percent'])) p.push(`${label}.${k}.percent: must be a number or null`);
      const of = lim['of'];
      if (of === 'max') continue;
      if (isObj(of) && typeof of['element'] === 'string') {
        if (!names.includes(of['element'])) p.push(`${label}.${k}: percent of unknown element "${of['element']}"`);
        else if (typeof e['name'] === 'string') percentEdges.push([e['name'], of['element']]);
      } else if (isObj(of) && typeof of['parameter'] === 'string') {
        if (!paramNames.has(of['parameter'])) p.push(`${label}.${k}: percent of unknown parameter "${of['parameter']}"`);
      } else p.push(`${label}.${k}.of: must be "max", { "element": name } or { "parameter": name }`);
    }
  });

  // Circular references through percentages and ratios
  const deps = new Map<string, string[]>();
  for (const [a, b] of percentEdges) deps.set(a, [...(deps.get(a) ?? []), b]);
  list.forEach((e) => {
    if (isObj(e) && e['type'] === 'ratio' && typeof e['name'] === 'string') {
      deps.set(e['name'], [...(deps.get(e['name']) ?? []), ...[e['a'], e['b']].filter((x): x is string => typeof x === 'string')]);
    }
  });
  const visiting = new Set<string>();
  const done = new Set<string>();
  const visit = (n: string, path: string[]): void => {
    if (done.has(n)) return;
    if (visiting.has(n)) {
      p.push(`elements: circular reference ${[...path, n].join(' → ')}`);
      return;
    }
    visiting.add(n);
    for (const d of deps.get(n) ?? []) visit(d, [...path, n]);
    visiting.delete(n);
    done.add(n);
  };
  for (const n of deps.keys()) visit(n, []);

  if (p.length) throw new RegulationError(p);
  return { ...(o as unknown as Regulation), verified: o['verified'] === true, parameters: (params as Record<string, number | null>) ?? {} };
}
