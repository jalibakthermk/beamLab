import type { PhotometricDataset } from '../model/dataset';
import type { Aim } from '../geometry/rotate';
import { RoadError, type RoadLamp } from './illuminance';

/**
 * Road and vehicle setup (Phase 7). Vehicle frame as in illuminance.ts:
 * x forward, y right, z up, origin on the ground below the vehicle front centre.
 *
 * No hidden defaults: every mounting, separation, aim and lane value must be
 * entered by the user (or come from a preset file they chose).
 */

export type TrafficSide = 'right' | 'left';
export const LINE_NAMES = ['vehicle-axis', 'lane-centre', 'lane-left-edge', 'lane-right-edge'] as const;
export type LineName = (typeof LINE_NAMES)[number];

export interface LaneSetup {
  laneWidth: number | null;
  /** Lanes in the vehicle's direction of travel. */
  lanes: number | null;
  /** 'right': right-hand traffic (lane 1 is the rightmost); 'left': left-hand traffic (lane 1 is the leftmost). */
  trafficSide: TrafficSide | null;
  /** Lane the vehicle drives in, 1 = the lane at the road edge on the traffic side. */
  ownLane: number | null;
  /** Vehicle centre line minus lane centre, m, positive right. */
  offset: number | null;
}

export interface RoadLayout {
  /** Named lines (y, m) for reach evaluation. */
  lines: Record<LineName, number>;
  /** Road edges and lane lines, ascending y. */
  markings: Array<{ y: number; kind: 'edge' | 'lane' }>;
  road: { yMin: number; yMax: number };
  laneWidth: number;
}

const r9 = (x: number) => {
  const r = Number(x.toFixed(9));
  return r === 0 ? 0 : r;
};

function need(value: number | null | undefined, what: string, check: (x: number) => boolean = () => true, rule = ''): number {
  if (value === null || value === undefined || typeof value !== 'number' || !Number.isFinite(value)) throw new RoadError(`${what} must be entered`);
  if (!check(value)) throw new RoadError(`${what} ${rule}`);
  return value;
}

export function laneLayout(s: LaneSetup): RoadLayout {
  const w = need(s.laneWidth, 'lane width', (x) => x > 0, 'must be positive');
  const n = need(s.lanes, 'number of lanes', (x) => Number.isInteger(x) && x >= 1, 'must be a whole number ≥ 1');
  if (s.trafficSide !== 'right' && s.trafficSide !== 'left') throw new RoadError('traffic side must be entered (right or left)');
  const own = need(s.ownLane, 'own lane', (x) => Number.isInteger(x) && x >= 1 && x <= n, `must be a lane number from 1 to ${n}`);
  const offset = need(s.offset, 'vehicle position in the lane');
  const centre = -offset;
  // Edge on the traffic side, and the road's far edge
  const sign = s.trafficSide === 'right' ? 1 : -1;
  const kerb = centre + sign * (own - 0.5) * w;
  const far = kerb - sign * n * w;
  const markings: RoadLayout['markings'] = [];
  for (let k = 0; k <= n; k++) markings.push({ y: r9(kerb - sign * k * w), kind: k === 0 || k === n ? 'edge' : 'lane' });
  markings.sort((a, b) => a.y - b.y);
  return {
    lines: { 'vehicle-axis': 0, 'lane-centre': r9(centre), 'lane-left-edge': r9(centre - w / 2), 'lane-right-edge': r9(centre + w / 2) },
    markings,
    road: { yMin: r9(Math.min(kerb, far)), yMax: r9(Math.max(kerb, far)) },
    laneWidth: w,
  };
}

// ── Lamp pair ────────────────────────────────────────────────────────────

export interface LampPairInput {
  /** File for the left lamp, or for both if `right` is null. */
  left: PhotometricDataset;
  /** Separate file for the right lamp; null to use `left` for both. */
  right: PhotometricDataset | null;
  /** Which lamp uses its file mirrored in H. */
  mirror: 'none' | 'left' | 'right';
  /** Distance between the lamp centres, m. */
  separation: number | null;
  /** Mounting height of the lamp centres above the road, m. */
  height: number | null;
  /** Forward position of the lamp centres (0 = vehicle front), m. */
  x: number | null;
  aimLeft: Aim | null;
  aimRight: Aim | null;
}

function needAim(a: Aim | null, label: string): Aim {
  if (!a || ![a.yaw, a.pitch, a.roll].every((x) => typeof x === 'number' && Number.isFinite(x))) {
    throw new RoadError(`${label} aim must be entered (yaw, pitch and roll)`);
  }
  return { yaw: a.yaw, pitch: a.pitch, roll: a.roll };
}

/** The aim of the opposite lamp in a mirror-symmetric pair: yaw and roll change sign. */
export function mirrorAim(a: Aim): Aim {
  const z = (x: number) => (x === 0 ? 0 : x);
  return { yaw: z(-a.yaw), pitch: a.pitch, roll: z(-a.roll) };
}

/** Two lamps: left at y = −separation / 2, right at +separation / 2. */
export function lampPair(p: LampPairInput): RoadLamp[] {
  const sep = need(p.separation, 'lamp separation', (x) => x >= 0, 'must not be negative');
  const height = need(p.height, 'mounting height');
  const x = need(p.x, 'lamp position x');
  const aimLeft = needAim(p.aimLeft, 'left lamp');
  const aimRight = needAim(p.aimRight, 'right lamp');
  return [
    { name: 'left', dataset: p.left, position: { x, y: r9(-sep / 2), height }, aim: aimLeft, mirror: p.mirror === 'left' },
    { name: 'right', dataset: p.right ?? p.left, position: { x, y: r9(sep / 2), height }, aim: aimRight, mirror: p.mirror === 'right' },
  ];
}

// ── Vehicle presets (data/presets/vehicles/) ─────────────────────────────

export interface VehiclePreset {
  label: string;
  /** True for made-up example values (not a real vehicle). */
  example: boolean;
  notes?: string;
  lamps: { x: number; height: number; separation: number; mirror: 'none' | 'left' | 'right'; aimLeft: Aim; aimRight: Aim };
  lanes: { laneWidth: number; lanes: number; trafficSide: TrafficSide; ownLane: number; offset: number };
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

export function parseVehiclePreset(obj: unknown): VehiclePreset {
  const p: string[] = [];
  if (!isObj(obj)) throw new RoadError('vehicle preset: must be an object');
  if (typeof obj['label'] !== 'string') p.push('label: must be a string');
  if (typeof obj['example'] !== 'boolean') p.push('example: must be true or false');
  const lamps = isObj(obj['lamps']) ? obj['lamps'] : (p.push('lamps: must be an object'), {});
  for (const k of ['x', 'height', 'separation']) if (!isNum(lamps[k])) p.push(`lamps.${k}: must be a number`);
  if (!['none', 'left', 'right'].includes(lamps['mirror'] as string)) p.push('lamps.mirror: must be none, left or right');
  for (const k of ['aimLeft', 'aimRight']) {
    const a = lamps[k];
    if (!isObj(a) || !['yaw', 'pitch', 'roll'].every((q) => isNum(a[q]))) p.push(`lamps.${k}: must have numbers yaw, pitch and roll`);
  }
  const lanes = isObj(obj['lanes']) ? obj['lanes'] : (p.push('lanes: must be an object'), {});
  for (const k of ['laneWidth', 'lanes', 'ownLane', 'offset']) if (!isNum(lanes[k])) p.push(`lanes.${k}: must be a number`);
  if (lanes['trafficSide'] !== 'right' && lanes['trafficSide'] !== 'left') p.push('lanes.trafficSide: must be right or left');
  if (p.length) throw new RoadError(`vehicle preset:\n- ${p.join('\n- ')}`);
  return obj as unknown as VehiclePreset;
}

// ── Points text (Road tab) ───────────────────────────────────────────────

export interface ParsedPoint {
  name: string;
  point: [number, number, number];
  /** Road (+z) or vertical plane facing the vehicle (−x). */
  normal: [number, number, number];
}

/**
 * One point per line: `x y z plane [name]`, separated by spaces or semicolons;
 * plane is "road" or "vertical". Blank lines and lines starting with # are skipped.
 */
export function parsePoints(text: string): { points: ParsedPoint[]; errors: string[] } {
  const points: ParsedPoint[] = [];
  const errors: string[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const parts = line.split(/[\s;]+/);
    const nums = parts.slice(0, 3).map((x) => Number(x.replace(',', '.')));
    const plane = (parts[3] ?? '').toLowerCase();
    if (parts.length < 4 || !nums.every(Number.isFinite) || (plane !== 'road' && plane !== 'vertical')) {
      errors.push(`line ${i + 1}: expected "x y z road|vertical [name]", got "${line}"`);
      return;
    }
    points.push({
      name: parts.slice(4).join(' ') || `P${points.length + 1}`,
      point: [nums[0]!, nums[1]!, nums[2]!],
      normal: plane === 'road' ? [0, 0, 1] : [-1, 0, 0],
    });
  });
  return { points, errors };
}
