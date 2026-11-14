import { createDataset, type PhotometricDataset } from '../model/dataset';
import { makeProvenance, type Provenance } from '../model/provenance';
import { fnv1a } from '../model/hash';
import { anglesFromMatrix, multiplyMatrices, rotate, transpose } from '../geometry/rotate';
import { scanCutoff, traceCutoff, type TrafficSide } from '../analysis/cutoff';

/**
 * Aim to cut-off (FRAMEWORK.md section 6.1/6.2): rotate a dataset so its
 * horizontal cut-off sits at a chosen V (and optionally the elbow at H = 0).
 * Iterates analyse → rotate → re-analyse. Each rotation composes with the
 * previous one, so the original is resampled only once per step and the
 * result never accumulates blur.
 */

export type AimErrorCode = 'NO_CUTOFF' | 'NO_ELBOW';

/** Smallest Gmax accepted as a cut-off for aiming (same default as the trace). */
const MIN_G = 0.05;

export class AimError extends Error {
  override name = 'AimError';
  readonly code: AimErrorCode;
  constructor(code: AimErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** Cut-off V (degrees, negative = down) for an inclination given in percent down: −atan(p / 100). 1% → −0.573°. */
export function cutoffVFromPercentDown(percent: number): number {
  return (-Math.atan(percent / 100) * 180) / Math.PI;
}

export interface AimOptions {
  /** Target cut-off V (degrees). */
  targetV: number;
  /** H of the vertical scan that measures the cut-off (on the horizontal part). */
  scanH: number;
  vMin: number;
  vMax: number;
  step?: number;
  traffic: TrafficSide;
  /** Also yaw so the elbow is at H = 0 (needs a two-segment trace). */
  elbowAtZero?: boolean;
  /** H range of the trace used to find the elbow. Default −8..8 at 0.5°. */
  trace?: { hMin: number; hMax: number; hStep: number };
  /** Stop when |cut-off V − target| ≤ tolV (default 0.005°) and |elbow H| ≤ tolH (default 0.02°). */
  tolV?: number;
  tolH?: number;
  /** Default 8. */
  maxSteps?: number;
  name?: string;
  timestamp?: string;
}

export interface AimResult {
  dataset: PhotometricDataset;
  /** Correction applied to the input (degrees). */
  yaw: number;
  pitch: number;
  /** Remaining error: cut-off V − target, and elbow H (null if the elbow was not aimed). */
  residual: { v: number; h: number | null };
  /** Number of rotations applied. */
  steps: number;
  converged: boolean;
  history: Array<{ cutV: number; elbowH: number | null }>;
}

export function aimToCutoff(input: PhotometricDataset, o: AimOptions): AimResult {
  const tolV = o.tolV ?? 0.005;
  const tolH = o.tolH ?? 0.02;
  const maxSteps = o.maxSteps ?? 8;
  const trace = o.trace ?? { hMin: -8, hMax: 8, hStep: 0.5 };
  const elbow = o.elbowAtZero ?? false;

  const measure = (d: PhotometricDataset) => {
    const s = scanCutoff(d, { h: o.scanH, vMin: o.vMin, vMax: o.vMax, ...(o.step ? { step: o.step } : {}) });
    if (!s.found || s.gMax < MIN_G) {
      throw new AimError('NO_CUTOFF', `No clear cut-off at H ${o.scanH}° between V ${o.vMin}° and ${o.vMax}° (Gmax ${Number.isFinite(s.gMax) ? s.gMax.toFixed(3) : 'none'}, need ≥ ${MIN_G}).`);
    }
    let elbowH: number | null = null;
    if (elbow) {
      const t = traceCutoff(d, { ...trace, vMin: o.vMin, vMax: o.vMax, traffic: o.traffic, ...(o.step ? { step: o.step } : {}) });
      if (!t.fit) throw new AimError('NO_ELBOW', `The elbow could not be located: ${t.reason ?? 'no fit'}`);
      elbowH = t.fit.elbow.h;
    }
    return { cutV: s.v, elbowH };
  };

  let current = input;
  const history: AimResult['history'] = [];
  let steps = 0;
  let converged = false;
  let m = measure(current);
  history.push(m);
  for (;;) {
    const eV = m.cutV - o.targetV;
    const eH = m.elbowH ?? 0;
    if (Math.abs(eV) <= tolV && (!elbow || Math.abs(eH) <= tolH)) {
      converged = true;
      break;
    }
    if (steps >= maxSteps) break;
    current = rotate(current, { yaw: elbow ? -eH : 0, pitch: -eV, roll: 0 }).dataset;
    steps++;
    m = measure(current);
    history.push(m);
  }

  // Correction relative to the input (the input may itself be a rotation result)
  let yaw = 0;
  let pitch = 0;
  if (current !== input && current.rotationOf) {
    const base = input.rotationOf;
    const corr = base ? multiplyMatrices(current.rotationOf.matrix, transpose(base.matrix)) : current.rotationOf.matrix;
    ({ yaw, pitch } = anglesFromMatrix(corr));
  }
  const residual = { v: m.cutV - o.targetV, h: elbow ? m.elbowH : null };

  const params: Record<string, unknown> = {
    inputNames: [input.name],
    targetV: o.targetV,
    elbowAtZero: elbow,
    scanH: o.scanH,
    vWindow: { min: o.vMin, max: o.vMax },
    traffic: o.traffic,
    tolerance: { v: tolV, h: tolH },
    maxSteps,
    steps,
    converged,
    yaw,
    pitch,
    residualV: residual.v,
    residualH: residual.h,
    resampledFrom: current.rotationOf?.source.name ?? input.name,
  };
  const provenance: Provenance = {
    ...makeProvenance('aim-to-cutoff', [input.id], params, o.timestamp),
    parents: [{ id: input.id, name: input.name, kind: input.kind, provenance: input.provenance }],
  };
  const dataset = createDataset({
    ...current,
    id: `aim-${fnv1a(JSON.stringify([input.id, o.targetV, elbow, o.scanH, yaw, pitch]))}`,
    name: o.name ?? `${input.name} aimed`,
    values: current === input ? input.values.slice() : current.values,
    provenance,
  });
  return { dataset, yaw, pitch, residual, steps, converged, history };
}

/** Inclination in percent down for a cut-off V (degrees): −100·tan(V). −0.573° → 1%. */
export function percentDownFromV(v: number): number {
  return -100 * Math.tan((v * Math.PI) / 180);
}
