import { describe, expect, it } from 'vitest';
import {
  evaluateSharpness,
  fitSegments,
  G_DELTA,
  parseCutoffPreset,
  scanCutoff,
  traceCutoff,
} from '../core/analysis/cutoff';
import { parseIes } from '../core/io/ies';
import { rotate } from '../core/geometry/rotate';
import { CUTOFF, cutoffGmax, KINK, measuredCut, NOISE, PLAIN_V0, range, sigmoid } from './fixtures/generate';
import { fixture } from './load-fixture';
import { mk } from './helpers';

const load = (n: string) => parseIes(fixture(n), { name: n }).dataset;
const fine = load('cutoff-plain-fine.ies');
const coarse = load('cutoff-plain-coarse.ies');
const noisy = load('cutoff-plain-noisy.ies');
const kinkR = load('cutoff-kink-rht.ies');
const kinkL = load('cutoff-kink-lht.ies');
const WINDOW = { vMin: -3, vMax: 2 };
const EXPECTED_V = measuredCut(PLAIN_V0); // -0.57
const EXPECTED_G = cutoffGmax(); // 0.4128

const presetFiles = import.meta.glob<unknown>('../data/presets/cutoff/*.json', { import: 'default', eager: true });

describe('vertical gradient scan', () => {
  it('fine fixture: cut-off position within 0.005° and Gmax within 1%', () => {
    const s = scanCutoff(fine, { h: 0, ...WINDOW });
    expect(s.found).toBe(true);
    expect(Math.abs(s.v - EXPECTED_V)).toBeLessThan(0.005);
    expect(Math.abs(s.gMax / EXPECTED_G - 1)).toBeLessThan(0.01);
    expect(Math.abs(s.vNode - EXPECTED_V)).toBeLessThanOrEqual(0.025 + 1e-9); // nearest 0.05° scan node
    expect(s.nativeStep).toBeCloseTo(0.05, 9);
    expect(s.coarse).toBe(false);
    expect(s.secondary).toEqual([]);
    expect(s.curve.v.length).toBe(s.curve.g.length);
    expect(s.curve.v.length).toBe(s.curve.i.length);
    expect(s.curve.v[0]).toBe(-3);
    expect(s.curve.v[1]! - s.curve.v[0]!).toBeCloseTo(0.05, 12); // default step
    expect(G_DELTA).toBe(0.1);
  });

  it('G does not depend on the horizontal intensity level: same answer at H = -6', () => {
    const s = scanCutoff(fine, { h: -6, ...WINDOW });
    expect(Math.abs(s.v - EXPECTED_V)).toBeLessThan(0.005);
    expect(Math.abs(s.gMax / EXPECTED_G - 1)).toBeLessThan(0.01);
  });

  it('coarse fixture (0.25° V step): warning flag raised, native step reported', () => {
    const s = scanCutoff(coarse, { h: 0, ...WINDOW });
    expect(s.coarse).toBe(true);
    expect(s.nativeStep).toBeCloseTo(0.25, 9);
    expect(Math.abs(s.v - EXPECTED_V)).toBeLessThan(0.15);
  });

  it('noisy fixture: correct cut-off found, and the weaker second step reported as a secondary maximum', () => {
    const s = scanCutoff(noisy, { h: 0, ...WINDOW });
    expect(Math.abs(s.v - EXPECTED_V)).toBeLessThan(0.02);
    expect(s.secondary.length).toBe(1);
    const sec = s.secondary[0]!;
    expect(Math.abs(sec.v - measuredCut(NOISE.secondC))).toBeLessThan(0.06);
    expect(Math.abs(sec.g - cutoffGmax(NOISE.secondA))).toBeLessThan(0.03);
    // a higher threshold hides it
    expect(scanCutoff(noisy, { h: 0, ...WINDOW, secondaryFraction: 0.6 }).secondary).toEqual([]);
  });

  it('intensity at or below zero gives NaN for G, never an error or infinity', () => {
    const v = range(-2, 2, 0.05);
    const ds = mk(range(-2, 2, 1), v, (_h, vv) => (vv > 0.5 ? 0 : vv > 0.3 ? -5 : 10 ** (3 - 2.5 * (1 - sigmoid(vv + 0.5)))));
    const s = scanCutoff(ds, { h: 0, vMin: -2, vMax: 1.9 });
    expect(s.curve.g.every((g) => Number.isNaN(g) || Number.isFinite(g))).toBe(true);
    s.curve.v.forEach((vv, i) => {
      if (vv + G_DELTA > 0.3 + 1e-9) expect(s.curve.g[i]).toBeNaN();
    });
    expect(s.found).toBe(true);
    expect(Math.abs(s.v - measuredCut(-0.5))).toBeLessThan(0.005);
  });

  it('a scan outside the data finds nothing (NaN, no error)', () => {
    const s = scanCutoff(fine, { h: 40, ...WINDOW });
    expect(s.found).toBe(false);
    expect(s.v).toBeNaN();
  });

  // 0.01°: bilinear resampling of the steep cut-off shifts the measured position by ~0.005° (measured 0.0051°)
  it('a fixture pitched by 0.33° moves the cut-off by 0.33° at H = 0 (within 0.01°)', () => {
    const pitched = rotate(fine, { yaw: 0, pitch: 0.33, roll: 0 }).dataset;
    const s = scanCutoff(pitched, { h: 0, ...WINDOW });
    expect(Math.abs(s.v - (EXPECTED_V + 0.33))).toBeLessThan(0.01);
  });
});

describe('scan settings as data (data/presets/cutoff)', () => {
  it('every preset file parses; the template has all numeric fields null', () => {
    const entries = Object.entries(presetFiles).filter(([f]) => !f.endsWith('schema.json'));
    expect(entries.length).toBeGreaterThanOrEqual(1);
    for (const [, obj] of entries) parseCutoffPreset(obj);
    const tpl = parseCutoffPreset(presetFiles['../data/presets/cutoff/template.json']);
    expect(tpl.scanH).toBeNull();
    expect(tpl.vWindow).toEqual({ min: null, max: null });
    expect(tpl.sharpness).toEqual({ min: null, max: null });
    expect(tpl.source).toBeNull();
    expect(tpl.revision).toBeNull();
  });

  it('the schema lists the required fields', () => {
    const schema = presetFiles['../data/presets/cutoff/schema.json'] as { required: string[] };
    expect(schema.required).toEqual(['id', 'title', 'source', 'revision', 'trafficSide', 'scanH', 'vWindow', 'sharpness']);
  });

  it('rejects malformed presets with a clear message', () => {
    expect(() => parseCutoffPreset({ id: 'x' })).toThrow(/title/);
    expect(() =>
      parseCutoffPreset({ id: 'x', title: 'x', source: null, revision: null, trafficSide: 'up', scanH: null, vWindow: { min: null, max: null }, sharpness: { min: null, max: null } }),
    ).toThrow(/trafficSide/);
    expect(() =>
      parseCutoffPreset({ id: 'x', title: 'x', source: null, revision: null, trafficSide: null, scanH: '2', vWindow: { min: null, max: null }, sharpness: { min: null, max: null } }),
    ).toThrow(/scanH/);
  });

  it('with limits: pass or fail and the margin; with null limits: values only', () => {
    // Synthetic limits for the test only (not regulation values)
    expect(evaluateSharpness(0.4, { min: null, max: null })).toEqual({ status: 'no-limits', margin: null });
    expect(evaluateSharpness(0.4, { min: 0.1, max: 1 })).toEqual({ status: 'pass', margin: expect.closeTo(0.3, 12) });
    expect(evaluateSharpness(0.4, { min: 1, max: 2 })).toEqual({ status: 'fail', margin: expect.closeTo(-0.6, 12) });
    expect(evaluateSharpness(0.4, { min: null, max: 0.35 })).toEqual({ status: 'fail', margin: expect.closeTo(-0.05, 12) });
    expect(evaluateSharpness(NaN, { min: 0.1, max: 1 })).toEqual({ status: 'fail', margin: null });
  });
});

describe('cut-off line trace', () => {
  const TRACE = { hMin: -8, hMax: 8, hStep: 0.5, ...WINDOW };
  const kinkV = measuredCut(KINK.V0); // -0.30

  it('RHT kinked fixture: horizontal part, elbow and 15° shoulder recovered', () => {
    const t = traceCutoff(kinkR, { ...TRACE, traffic: 'RHT' });
    expect(t.poorFit).toBe(false);
    const f = t.fit!;
    expect(Math.abs(f.elbow.h - KINK.he)).toBeLessThan(0.02); // breakpoint searched at 0.01°; measured exact
    expect(Math.abs(f.elbow.v - kinkV)).toBeLessThan(0.01);
    expect(Math.abs(f.shoulderAngle - KINK.angle)).toBeLessThan(0.05); // measured 15.00003°
    expect(Math.abs(f.horizontal.meanV - kinkV)).toBeLessThan(0.01);
    expect(Math.abs(f.horizontal.slopeDeg)).toBeLessThan(0.1);
    expect(f.horizontal.maxDev).toBeLessThan(0.01);
    expect(f.horizontal.rmsDev).toBeLessThan(0.005);
    expect(f.residualRms).toBeLessThan(0.01);
    expect(t.points.length).toBe(33);
  });

  it('fitSegments gives the drawn segments meeting at the elbow', () => {
    const f = traceCutoff(kinkR, { ...TRACE, traffic: 'RHT' }).fit!;
    const seg = fitSegments(f, 'RHT', -8, 8);
    expect(seg.horizontal[1]).toEqual(seg.shoulder[0]);
    expect(seg.horizontal[0]![0]).toBe(-8);
    expect(seg.shoulder[1]![0]).toBe(8);
    expect(seg.shoulder[1]![1]).toBeCloseTo(kinkV + 7 * Math.tan((15 * Math.PI) / 180), 2);
  });

  it('LHT mirror with traffic side LHT: elbow at H = -1, shoulder 15° to the left', () => {
    const t = traceCutoff(kinkL, { ...TRACE, traffic: 'LHT' });
    expect(t.poorFit).toBe(false);
    expect(Math.abs(t.fit!.elbow.h + KINK.he)).toBeLessThan(0.02);
    expect(Math.abs(t.fit!.shoulderAngle - KINK.angle)).toBeLessThan(0.05);
  });

  it('wrong traffic side: the "horizontal" part comes out inclined, so the fit is flagged', () => {
    const t = traceCutoff(kinkR, { ...TRACE, traffic: 'LHT' });
    expect(t.poorFit).toBe(true);
    expect(t.fit).toBeNull();
    expect(t.reason).toMatch(/traffic side/i);
  });

  it('a stepped (Z-shaped) cut-off is flagged and the raw trace returned without a forced fit', () => {
    const h = range(-8, 8, 0.5);
    const v = range(-3, 2, 0.05);
    const c = (hh: number) => (hh < -2 ? -0.5 : hh <= 2 ? 0.5 : -0.5);
    const ds = mk(h, v, (hh, vv) => 10 ** (CUTOFF.BASE - CUTOFF.A * (1 - sigmoid(vv - c(hh)))));
    const t = traceCutoff(ds, { ...TRACE, traffic: 'RHT' });
    expect(t.poorFit).toBe(true);
    expect(t.fit).toBeNull();
    expect(t.points.length).toBe(33);
    expect(t.points.every((p) => Number.isFinite(p.v))).toBe(true);
  });
});
