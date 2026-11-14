import type { Vec3 } from '../geometry/coords';
import { RoadError, type IlluminanceField } from './illuminance';

/**
 * Road results (Phase 7): reach of isolux levels along lines, beam width at
 * distances, maximum. All illuminances in lx, distances in m.
 *
 * Profiles are sampled (positions s, values e). A crossing of a level is
 * interpolated linearly between two neighbouring known samples. Unknown
 * samples (NaN) are never interpolated into; they are counted and flagged.
 * "At or above": a sample equal to the level counts as reached.
 */

export type Evaluate = (point: Vec3, normal?: Vec3) => number;

export interface Profile {
  s: number[];
  e: number[];
}

export interface Crossing {
  at: number;
  /** 'down': from at/above the level to below it, going along s. */
  direction: 'up' | 'down';
}

export function checkLevels(levels: number[]): number[] {
  if (levels.length === 0) throw new RoadError('enter at least one isolux level');
  for (const l of levels) if (!(typeof l === 'number' && Number.isFinite(l) && l > 0)) throw new RoadError(`isolux level ${String(l)} must be a positive number`);
  const s = [...levels].sort((a, b) => a - b);
  for (let i = 1; i < s.length; i++) if (s[i] === s[i - 1]) throw new RoadError(`isolux level ${s[i]} is given twice`);
  return s;
}

const r9 = (x: number) => {
  const r = Number(x.toFixed(9));
  return r === 0 ? 0 : r;
};

function cross(s0: number, e0: number, s1: number, e1: number, level: number): number {
  return r9(s0 + ((e0 - level) / (e0 - e1)) * (s1 - s0));
}

/** Every crossing of the level between neighbouring known samples, in order of s. */
export function crossings(p: Profile, level: number): Crossing[] {
  const out: Crossing[] = [];
  for (let i = 0; i + 1 < p.s.length; i++) {
    const e0 = p.e[i]!;
    const e1 = p.e[i + 1]!;
    if (!Number.isFinite(e0) || !Number.isFinite(e1)) continue;
    const a0 = e0 >= level;
    const a1 = e1 >= level;
    if (a0 === a1) continue;
    out.push({ at: cross(p.s[i]!, e0, p.s[i + 1]!, e1, level), direction: a0 ? 'down' : 'up' });
  }
  return out;
}

export interface ReachOnProfile {
  /** Furthest s at which E is still at or above the level (known data only); null if never reached. */
  reach: number | null;
  crossings: Crossing[];
  /** The profile crosses the level more than once. */
  multiple: boolean;
  /** The level is still reached at the last sample: the true reach is at least `reach`. */
  beyondEnd: boolean;
  /** Unknown samples lie beyond the reach: the true reach could be further. */
  unknownBeyond: boolean;
  unknownCount: number;
}

export function reachOnProfile(p: Profile, level: number): ReachOnProfile {
  const n = p.s.length;
  let last = -1;
  let unknownCount = 0;
  for (let i = 0; i < n; i++) {
    const e = p.e[i]!;
    if (!Number.isFinite(e)) unknownCount++;
    else if (e >= level) last = i;
  }
  const cs = crossings(p, level);
  let unknownBeyond = false;
  for (let i = last + 1; i < n; i++) if (!Number.isFinite(p.e[i]!)) unknownBeyond = true;
  let reach: number | null = null;
  let beyondEnd = false;
  if (last >= 0) {
    if (last === n - 1) {
      reach = p.s[last]!;
      beyondEnd = true;
    } else {
      const e1 = p.e[last + 1]!;
      reach = Number.isFinite(e1) ? cross(p.s[last]!, p.e[last]!, p.s[last + 1]!, e1, level) : p.s[last]!;
    }
  }
  return { reach, crossings: cs, multiple: cs.length > 1, beyondEnd, unknownBeyond, unknownCount };
}

export interface ReachResult extends ReachOnProfile {
  level: number;
  y: number;
}

export function lineProfile(evaluate: Evaluate, y: number, xs: number[]): Profile {
  return { s: xs, e: xs.map((x) => evaluate([x, y, 0])) };
}

/** Reach of a level along the road line y = const, sampled at xs. */
export function reach(evaluate: Evaluate, y: number, xs: number[], level: number): ReachResult {
  return { level, y, ...reachOnProfile(lineProfile(evaluate, y, xs), level) };
}

export interface WidthOnProfile {
  /** Smallest and largest s of the area at or above the level; null if never reached. */
  from: number | null;
  to: number | null;
  width: number | null;
  /** Each separate stretch at or above the level. */
  segments: Array<[number, number]>;
  multiple: boolean;
  /** The area reaches an end of the profile: the true width may be larger. */
  clipped: boolean;
  /** The area runs into unknown samples: the true width may be larger. */
  unknownAdjacent: boolean;
  unknownCount: number;
}

export function widthOnProfile(p: Profile, level: number): WidthOnProfile {
  const n = p.s.length;
  const segments: Array<[number, number]> = [];
  let start: number | null = null;
  let clipped = false;
  let unknownAdjacent = false;
  let unknownCount = 0;
  for (let i = 0; i < n; i++) {
    const e = p.e[i]!;
    const known = Number.isFinite(e);
    if (!known) unknownCount++;
    const at = known && e >= level;
    if (at && start === null) {
      const prev = i > 0 ? p.e[i - 1]! : NaN;
      if (i === 0) {
        start = p.s[0]!;
        clipped = true;
      } else if (Number.isFinite(prev)) start = cross(p.s[i - 1]!, prev, p.s[i]!, e, level);
      else {
        start = p.s[i]!;
        unknownAdjacent = true;
      }
    }
    if (at && start !== null) {
      const next = i + 1 < n ? p.e[i + 1]! : NaN;
      const nextAt = i + 1 < n && Number.isFinite(next) && next >= level;
      if (!nextAt) {
        let end: number;
        if (i === n - 1) {
          end = p.s[i]!;
          clipped = true;
        } else if (Number.isFinite(next)) end = cross(p.s[i]!, e, p.s[i + 1]!, next, level);
        else {
          end = p.s[i]!;
          unknownAdjacent = true;
        }
        segments.push([start, end]);
        start = null;
      }
    }
  }
  const from = segments.length ? segments[0]![0] : null;
  const to = segments.length ? segments[segments.length - 1]![1] : null;
  return { from, to, width: from !== null && to !== null ? r9(to - from) : null, segments, multiple: segments.length > 1, clipped, unknownAdjacent, unknownCount };
}

export interface WidthResult extends WidthOnProfile {
  level: number;
  x: number;
}

/** Beam width on the road at distance x for a level, across ys (from = rightmost negative y side, i.e. leftmost). */
export function width(evaluate: Evaluate, x: number, ys: number[], level: number): WidthResult {
  const p = { s: ys, e: ys.map((y) => evaluate([x, y, 0])) };
  return { level, x, ...widthOnProfile(p, level) };
}

/** Largest known value of a field and its position (col, row axes of the field). */
export function fieldMax(f: IlluminanceField): { value: number; col: number; row: number } | null {
  let best = -Infinity;
  let at = -1;
  for (let i = 0; i < f.values.length; i++) {
    const v = f.values[i]!;
    if (Number.isFinite(v) && v > best) {
      best = v;
      at = i;
    }
  }
  if (at < 0) return null;
  const nc = f.cols.length;
  return { value: best, col: f.cols[at % nc]!, row: f.rows[Math.floor(at / nc)]! };
}

export interface RoadPoint {
  name: string;
  point: Vec3;
  /** Plane normal; default the road (+z). */
  normal?: Vec3;
}

export function pointValues(evaluate: Evaluate, points: RoadPoint[]): Array<RoadPoint & { value: number }> {
  return points.map((p) => ({ ...p, value: evaluate(p.point, p.normal) }));
}
