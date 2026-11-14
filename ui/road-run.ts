import { messageText, toUserMessage } from '../core/messages';
import type { AppState } from './state/store';
import type { PhotometricDataset } from '../core/model/dataset';
import { parseLevels } from '../core/analysis/levels';
import { gridSize, DEFAULT_MAX_POINTS, type RoadLamp } from '../core/road/illuminance';
import { laneLayout, parsePoints, type RoadLayout } from '../core/road/setup';
import { runRoad, type RoadRunInput, type RoadRunResult } from '../core/road/results';
import type { RoadRequirements } from '../core/road/requirements';

/**
 * Builds the road calculation input from the Road tab settings and runs it in a
 * Web Worker (falls back to the main thread if workers are unavailable). The
 * latest result is kept in memory only.
 */

export interface Prepared {
  input: RoadRunInput | null;
  /** Why the calculation cannot run yet. */
  missing: string[];
  /** Problems in optional inputs (the calculation still runs). */
  warnings: string[];
  layout: RoadLayout | null;
  lamps: RoadLamp[];
}

const isNum = (x: number | null): x is number => typeof x === 'number' && Number.isFinite(x);

export function prepare(state: AppState, requirements: RoadRequirements | null): Prepared {
  const s = state.road;
  const missing: string[] = [];
  const warnings: string[] = [];
  const lamps: RoadLamp[] = [];
  if (!s.lamps.length) missing.push('Add at least one lamp (or set a lamp pair).');
  s.lamps.forEach((l, i) => {
    const label = `Lamp ${i + 1}`;
    const ds: PhotometricDataset | null = state.entries.find((e) => e.key === l.entryKey)?.dataset ?? null;
    const gaps: string[] = [];
    if (!ds) gaps.push('dataset');
    else if (ds.kind !== 'intensity') gaps.push('an intensity dataset');
    for (const [k, v] of [['x', l.x], ['y', l.y], ['height', l.height], ['yaw', l.yaw], ['pitch', l.pitch], ['roll', l.roll]] as const) if (!isNum(v)) gaps.push(k);
    if (gaps.length) missing.push(`${label}: enter ${gaps.join(', ')}.`);
    else lamps.push({ name: label, dataset: ds!, mirror: l.mirror, position: { x: l.x!, y: l.y!, height: l.height! }, aim: { yaw: l.yaw!, pitch: l.pitch!, roll: l.roll! } });
  });

  let layout: RoadLayout | null = null;
  const ln = s.lanes;
  const anyLane = [ln.laneWidth, ln.lanes, ln.trafficSide, ln.ownLane, ln.offset].some((x) => x !== null);
  if (anyLane) {
    try {
      layout = laneLayout(ln);
    } catch (e) {
      warnings.push(`Lane setup: ${toUserMessage(e).detail ?? messageText(toUserMessage(e))} (reach is shown on the vehicle axis until it is complete).`);
    }
  }

  const g = s.grid;
  const grid = { x: { min: g.xMin, max: g.xMax, step: g.xStep }, y: { min: g.yMin, max: g.yMax, step: g.yStep } };
  try {
    const n = gridSize(grid.x, grid.y);
    if (n > DEFAULT_MAX_POINTS) missing.push(`Grid has ${n.toLocaleString('en')} points, more than ${DEFAULT_MAX_POINTS.toLocaleString('en')}: use a larger step or a smaller range.`);
  } catch (e) {
    missing.push(`Grid: ${toUserMessage(e).detail ?? messageText(toUserMessage(e))}`);
  }

  const lv = parseLevels(s.levelsText);
  if (lv.invalid.length) warnings.push(`Isolux levels: ignored ${lv.invalid.join(', ')}.`);
  const levels = [...new Set(lv.levels.filter((x) => x > 0))].sort((a, b) => a - b);
  const wd = parseLevels(s.widthText);
  if (wd.invalid.length) warnings.push(`Width distances: ignored ${wd.invalid.join(', ')}.`);
  if (wd.levels.length && !isNum(s.widthLevel)) warnings.push('Width: enter the level (lx) to measure the width at.');
  const pts = parsePoints(s.pointsText);
  warnings.push(...pts.errors.map((e) => `Points, ${e}.`));

  const input: RoadRunInput | null = missing.length
    ? null
    : {
        lamps, grid, outside: s.outsideZero ? 'zero' : 'unknown', levels, layout,
        widthDistances: wd.levels, widthLevel: isNum(s.widthLevel) && s.widthLevel > 0 ? s.widthLevel : null,
        points: pts.points, requirements,
      };
  return { input, missing, warnings, layout, lamps };
}

// ── Running ──────────────────────────────────────────────────────────────

export interface RunState {
  key: string;
  running: boolean;
  result: RoadRunResult | null;
  /** The input the result belongs to. */
  input: RoadRunInput | null;
  error: string;
  inWorker: boolean;
}

let worker: Worker | null = null;
let workerFailed = false;
let seq = 0;
let latest: RunState = { key: '', running: false, result: null, input: null, error: '', inWorker: false };
let timer: ReturnType<typeof setTimeout> | null = null;

function getWorker(): Worker | null {
  if (workerFailed || typeof Worker === 'undefined') return null;
  if (!worker) {
    try {
      worker = new Worker(new URL('./road-worker.ts', import.meta.url), { type: 'module' });
    } catch {
      workerFailed = true;
      return null;
    }
  }
  return worker;
}

export const runState = (): RunState => latest;

/** Identity of an input: settings plus the datasets used (by object). */
const ids = new WeakMap<object, number>();
let idCounter = 0;
const idOf = (o: object) => {
  let v = ids.get(o);
  if (v === undefined) ids.set(o, (v = ++idCounter));
  return v;
};
export function inputKey(input: RoadRunInput): string {
  return JSON.stringify({ ...input, lamps: input.lamps.map((l) => ({ ...l, dataset: idOf(l.dataset) })), requirements: input.requirements ? idOf(input.requirements) : null });
}

/** Starts a calculation when the input changed (debounced); calls onUpdate when a result (or error) arrives. */
export function schedule(input: RoadRunInput | null, onUpdate: () => void): void {
  if (!input) {
    if (latest.key !== '') {
      latest = { key: '', running: false, result: null, input: null, error: '', inWorker: latest.inWorker };
      seq++;
    }
    return;
  }
  const key = inputKey(input);
  if (key === latest.key) return;
  const id = ++seq;
  latest = { ...latest, key, running: true, error: '' };
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    const done = (result: RoadRunResult | null, error: string, inWorker: boolean) => {
      if (id !== seq) return;
      latest = { key, running: false, result, input: result ? input : latest.input, error, inWorker };
      onUpdate();
    };
    const w = getWorker();
    if (w) {
      w.onmessage = (ev: MessageEvent<{ id: number; result?: RoadRunResult; error?: string }>) => {
        if (ev.data.id !== seq) return;
        done(ev.data.result ?? null, ev.data.error ?? '', true);
      };
      w.onerror = () => {
        // Worker could not start: compute here from now on
        workerFailed = true;
        worker = null;
        try {
          done(runRoad(input, () => performance.now()), '', false);
        } catch (e) {
          done(null, messageText(toUserMessage(e)), false);
        }
      };
      w.postMessage({ id, input });
    } else {
      try {
        done(runRoad(input, () => performance.now()), '', false);
      } catch (e) {
        done(null, messageText(toUserMessage(e)), false);
      }
    }
  }, 120);
}
