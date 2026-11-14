import type { PhotometricDataset } from '../model/dataset';
import { anglesToVector, vectorToAngles } from '../geometry/coords';
import { ANGLE_EPS, sample } from '../geometry/interpolate';
import { anglesFromMatrix, applyMatrix, multiplyMatrices, rotate, rotationMatrix, transpose, type Mat3 } from '../geometry/rotate';
import { aimToCutoff } from '../ops/aim';
import type { TrafficSide } from '../analysis/cutoff';
import { datasetField, EngineError, evaluateField, evaluateRegulation, type Conditions, type Field, type RegulationResult } from './engine';
import type { AimMode, Regulation } from './schema';

/**
 * Regulation check with an aim mode (FRAMEWORK.md section 5.1):
 *  - as loaded;
 *  - aim to cut-off first (Phase 5) at the regulation's nominal cut-off V;
 *  - re-aim search: within the permitted ± range, the yaw and pitch that
 *    maximise the worst margin (coarse grid, then refinement).
 * Rotations compose, so the original is resampled once.
 */

export interface AimOptions extends Conditions {
  mode: AimMode;
  /** Scan settings for aiming to the cut-off (tool defaults if missing). */
  cutoff?: { scanH: number; vMin: number; vMax: number; traffic: TrafficSide; step?: number };
  /** Search grid: points per axis in the coarse pass (default 9) and refinement rounds (default 6). */
  search?: { coarse?: number; rounds?: number };
}

export interface AimedEvaluation {
  mode: AimMode;
  /** Result at the aim used (the optimised aim for a re-aim search). */
  result: RegulationResult;
  /** Dataset at the aim used. */
  dataset: PhotometricDataset;
  /** Aim used, relative to the input (degrees). */
  aim: { yaw: number; pitch: number };
  /** Result at the nominal aim (as loaded, or aimed to cut-off when the file gives a nominal V). */
  nominal: RegulationResult;
  nominalAim: { yaw: number; pitch: number };
  optimised: RegulationResult | null;
  searchDisabledReason: string | null;
  notes: string[];
}

const DEFAULT_CUTOFF = { scanH: -2, vMin: -3, vMax: 2, traffic: 'RHT' as TrafficSide };

/** Rotation of `ds` relative to `input`, as yaw and pitch. */
function relativeAim(input: PhotometricDataset, ds: PhotometricDataset): { yaw: number; pitch: number } {
  if (ds === input || !ds.rotationOf) return { yaw: 0, pitch: 0 };
  const base = input.rotationOf;
  const m = base ? multiplyMatrices(ds.rotationOf.matrix, transpose(base.matrix)) : ds.rotationOf.matrix;
  const a = anglesFromMatrix(m);
  return { yaw: a.yaw, pitch: a.pitch };
}

/** View of `source` rotated by R on `grid`, without resampling the whole dataset (for the search only). */
function rotatedField(source: PhotometricDataset, r: Mat3, nominal: PhotometricDataset): Field {
  const rt = transpose(r);
  const c = source.coverage;
  const base = datasetField(source);
  return {
    value(h, v) {
      const s = vectorToAngles('A', applyMatrix(rt, anglesToVector('A', h, v)));
      if (s.h < c.hMin - ANGLE_EPS || s.h > c.hMax + ANGLE_EPS || s.v < c.vMin - ANGLE_EPS || s.v > c.vMax + ANGLE_EPS) return NaN;
      return sample(source, s.h, s.v);
    },
    grid: nominal.grid,
    coverage: nominal.coverage,
    // Rotation moves values, it does not change them: the maximum is the source maximum, at its rotated position
    max() {
      const m = base.max();
      const a = vectorToAngles('A', applyMatrix(r, anglesToVector('A', m.h, m.v)));
      return { value: m.value, h: a.h, v: a.v };
    },
  };
}

/** Worst margin in percent; elements that drop out of the data count as the worst possible. */
function objective(r: RegulationResult): number {
  let worst = Infinity;
  for (const e of r.elements) {
    if (e.status === 'not-evaluated') {
      if (e.reason?.startsWith('no limit') || e.reason?.includes('not supplied')) continue;
      return -Infinity;
    }
    worst = Math.min(worst, e.marginPercent!);
  }
  return worst;
}

export function evaluateWithAim(input: PhotometricDataset, reg: Regulation, opts: AimOptions): AimedEvaluation {
  const notes: string[] = [];
  if (!reg.aim.modes.includes(opts.mode)) {
    throw new EngineError('AIM_NOT_ALLOWED', `"${reg.title}" does not allow the aim mode "${opts.mode}" (allowed: ${reg.aim.modes.join(', ') || 'none'}).`);
  }
  const cond: Conditions = {
    ...(opts.traffic ? { traffic: opts.traffic } : {}),
    ...(opts.scaleFactor !== undefined ? { scaleFactor: opts.scaleFactor } : {}),
    ...(opts.lamps !== undefined ? { lamps: opts.lamps } : {}),
    ...(opts.step !== undefined ? { step: opts.step } : {}),
  };
  const cutoff = opts.cutoff ?? DEFAULT_CUTOFF;

  // Nominal aim
  let nominalDs = input;
  const wantsCutoff = opts.mode === 'aim-to-cutoff' || (opts.mode === 're-aim-search' && reg.aim.nominalCutoffV !== null && reg.aim.modes.includes('aim-to-cutoff'));
  if (wantsCutoff) {
    if (reg.aim.nominalCutoffV === null) {
      throw new EngineError('AIM_MISSING_VALUE', `"${reg.title}" does not give a nominal cut-off V, so it cannot be aimed to the cut-off.`);
    }
    const a = aimToCutoff(input, { targetV: reg.aim.nominalCutoffV, ...cutoff });
    nominalDs = a.dataset;
    notes.push(
      `Aimed to cut-off at V ${reg.aim.nominalCutoffV}° (scan H ${cutoff.scanH}°): pitch ${a.pitch.toFixed(3)}°, ${a.converged ? 'converged' : 'NOT converged'}, residual ${a.residual.v.toFixed(4)}°.`,
    );
  }
  const nominal = evaluateRegulation(nominalDs, reg, cond);
  const nominalAim = relativeAim(input, nominalDs);
  const done = (result: RegulationResult, ds: PhotometricDataset, optimised: RegulationResult | null, reason: string | null): AimedEvaluation => ({
    mode: opts.mode, result, dataset: ds, aim: relativeAim(input, ds), nominal, nominalAim, optimised, searchDisabledReason: reason, notes,
  });
  if (opts.mode !== 're-aim-search') return done(nominal, nominalDs, null, null);

  // Re-aim search within the permitted range
  const rh = reg.aim.reaim.h;
  const rv = reg.aim.reaim.v;
  if (rh === null || rv === null) {
    const missing = [rh === null ? 'H' : null, rv === null ? 'V' : null].filter(Boolean).join(' and ');
    const reason = `The permitted re-aim range in ${missing} is not supplied in the regulation file, so the re-aim search is disabled. The result is at the nominal aim.`;
    notes.push(reason);
    return done(nominal, nominalDs, null, reason);
  }
  const source = nominalDs.rotationOf?.source ?? nominalDs;
  const rNominal = nominalDs.rotationOf?.matrix ?? rotationMatrix({ yaw: 0, pitch: 0, roll: 0 });
  const score = (dy: number, dp: number) => {
    const r = multiplyMatrices(rotationMatrix({ yaw: dy, pitch: dp, roll: 0 }), rNominal);
    return objective(evaluateField(rotatedField(source, r, nominalDs), reg, cond));
  };
  const clamp = (x: number, lim: number) => Math.max(-lim, Math.min(lim, x));
  const n = Math.max(3, opts.search?.coarse ?? 9);
  let best = { dy: 0, dp: 0, s: score(0, 0) };
  let sh = rh === 0 ? 0 : (2 * rh) / (n - 1);
  let sv = rv === 0 ? 0 : (2 * rv) / (n - 1);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const dy = rh === 0 ? 0 : -rh + i * sh;
      const dp = rv === 0 ? 0 : -rv + j * sv;
      const s = score(dy, dp);
      if (s > best.s) best = { dy, dp, s };
    }
  }
  const rounds = opts.search?.rounds ?? 6;
  for (let k = 0; k < rounds; k++) {
    sh /= 2;
    sv /= 2;
    const centre = best;
    for (let i = -2; i <= 2; i++) {
      for (let j = -2; j <= 2; j++) {
        const dy = clamp(centre.dy + i * sh, rh);
        const dp = clamp(centre.dp + j * sv, rv);
        const s = score(dy, dp);
        if (s > best.s) best = { dy, dp, s };
      }
    }
  }
  const finalDs = rotate(nominalDs, { yaw: best.dy, pitch: best.dp, roll: 0 }).dataset;
  const optimised = evaluateRegulation(finalDs, reg, cond);
  notes.push(`Re-aim search within ±${rh}° H and ±${rv}° V: yaw ${best.dy.toFixed(3)}°, pitch ${best.dp.toFixed(3)}° from the nominal aim.`);
  return done(optimised, finalDs, optimised, null);
}
