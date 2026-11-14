import { describe, expect, it } from 'vitest';
import { aimToCutoff, AimError, cutoffVFromPercentDown, percentDownFromV } from '../core/ops/aim';
import { scanCutoff, traceCutoff } from '../core/analysis/cutoff';
import { rotate } from '../core/geometry/rotate';
import { parseIes } from '../core/io/ies';
import { KINK, measuredCut, PLAIN_V0 } from './fixtures/generate';
import { fixture } from './load-fixture';
import { mk } from './helpers';

const load = (n: string) => parseIes(fixture(n), { name: n }).dataset;
const kinkR = load('cutoff-kink-rht.ies');
const fine = load('cutoff-plain-fine.ies');
const ONE_PERCENT = cutoffVFromPercentDown(1);
const SETTINGS = { scanH: -2, vMin: -3, vMax: 2, traffic: 'RHT' as const, trace: { hMin: -8, hMax: 8, hStep: 0.5 } };

describe('aim to cut-off', () => {
  it('target in percent: 1% down is -0.573°', () => {
    expect(ONE_PERCENT).toBeCloseTo(-0.5729387, 6);
    expect(percentDownFromV(ONE_PERCENT)).toBeCloseTo(1, 12);
  });

  it('kinked fixture: cut-off to 1% down and elbow to H = 0, with the correct correction', () => {
    const r = aimToCutoff(kinkR, { ...SETTINGS, targetV: ONE_PERCENT, elbowAtZero: true, timestamp: '2026-11-14T00:00:00.000Z' });
    expect(r.converged).toBe(true);
    expect(r.steps).toBeLessThanOrEqual(5);
    // Correction: elbow at H = +1 → yaw −1; cut-off at −0.30 → pitch −0.273
    expect(Math.abs(r.yaw + KINK.he)).toBeLessThan(0.03);
    expect(Math.abs(r.pitch - (ONE_PERCENT - measuredCut(KINK.V0)))).toBeLessThan(0.01);
    expect(Math.abs(r.residual.v)).toBeLessThanOrEqual(0.005);
    expect(Math.abs(r.residual.h!)).toBeLessThanOrEqual(0.02);
    // Independent check on the result
    const s = scanCutoff(r.dataset, { h: SETTINGS.scanH, vMin: -3, vMax: 2 });
    expect(Math.abs(s.v - ONE_PERCENT)).toBeLessThanOrEqual(0.005);
    const t = traceCutoff(r.dataset, { ...SETTINGS.trace, vMin: -3, vMax: 2, traffic: 'RHT' });
    expect(Math.abs(t.fit!.elbow.h)).toBeLessThan(0.1);
  });

  it('records the target and the result in provenance, and resamples the source only once', () => {
    const r = aimToCutoff(kinkR, { ...SETTINGS, targetV: ONE_PERCENT, elbowAtZero: true });
    const p = r.dataset.provenance!;
    expect(p.op).toBe('aim-to-cutoff');
    expect(p.params['targetV']).toBeCloseTo(ONE_PERCENT, 12);
    expect(p.params['elbowAtZero']).toBe(true);
    expect(p.params['yaw']).toBeCloseTo(r.yaw, 12);
    expect(p.params['pitch']).toBeCloseTo(r.pitch, 12);
    expect(p.params['converged']).toBe(true);
    expect(r.dataset.rotationOf?.source).toBe(kinkR);
  });

  it('a mis-aimed plain beam (pitched up 0.8°) is brought back with pitch ≈ −0.803°, from the original', () => {
    const mis = rotate(fine, { yaw: 0, pitch: 0.8, roll: 0 }).dataset;
    const r = aimToCutoff(mis, { ...SETTINGS, scanH: 0, targetV: ONE_PERCENT });
    expect(r.converged).toBe(true);
    expect(Math.abs(r.pitch - (ONE_PERCENT - (measuredCut(PLAIN_V0) + 0.8)))).toBeLessThan(0.01);
    expect(r.yaw).toBeCloseTo(0, 9);
    expect(r.residual.h).toBeNull();
    expect(r.dataset.rotationOf?.source).toBe(fine); // composed: the original is resampled once
  });

  it('already within tolerance: no rotation needed', () => {
    const r = aimToCutoff(fine, { ...SETTINGS, scanH: 0, targetV: measuredCut(PLAIN_V0) });
    expect(r.converged).toBe(true);
    expect(r.yaw).toBe(0);
    expect(r.pitch).toBe(0);
  });

  it('no cut-off in the window: clear error', () => {
    const flat = mk([-5, 0, 5], [-3, -1, 0, 1, 2], () => 1000);
    expect(() => aimToCutoff(flat, { ...SETTINGS, scanH: 0, targetV: ONE_PERCENT })).toThrow(AimError);
  });
});
