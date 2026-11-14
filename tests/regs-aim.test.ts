import { describe, expect, it } from 'vitest';
import { evaluateWithAim } from '../core/regs/reaim';
import { evaluateRegulation, EngineError } from '../core/regs/engine';
import { parseRegulation, type Regulation } from '../core/regs/schema';
import { scanCutoff } from '../core/analysis/cutoff';
import { parseIes } from '../core/io/ies';
import { measuredCut, PLAIN_V0, range } from './fixtures/generate';
import { fixture } from './load-fixture';
import { mk } from './helpers';

// Invented test values only (not a regulation)
function testReg(over: Partial<Record<string, unknown>> = {}): Regulation {
  return parseRegulation({
    id: 'TEST-aim', title: 'TEST ONLY: invented values', source: 'test', revision: 'test', verified: false,
    units: 'cd', mirrorForLeftHandTraffic: true, parameters: {},
    aim: { modes: ['as-loaded', 'aim-to-cutoff', 're-aim-search'], nominalCutoffV: null, reaim: { h: 3, v: 2 } },
    elements: [{ type: 'point', name: 'C', h: 0, v: 0, min: 15000 }],
    ...over,
  });
}

// Spot deliberately mis-aimed to (H 1.5, V -0.8); the best aim puts it on (0, 0): yaw -1.5, pitch +0.8
const SPOT = { h: 1.5, v: -0.8, peak: 20000, sigma: 2 };
const spot = mk(range(-10, 10, 0.25), range(-6, 6, 0.25), (h, v) => 100 + SPOT.peak * Math.exp(-((h - SPOT.h) ** 2 + (v - SPOT.v) ** 2) / (2 * SPOT.sigma ** 2)), { name: 'spot' });

describe('aim modes', () => {
  it('as loaded: no rotation, same result as the plain engine', () => {
    const r = evaluateWithAim(spot, testReg(), { mode: 'as-loaded' });
    expect(r.aim).toEqual({ yaw: 0, pitch: 0 });
    expect(r.result).toEqual(evaluateRegulation(spot, testReg()));
    expect(r.optimised).toBeNull();
  });

  it('a mode the file does not allow is refused', () => {
    const reg = testReg({ aim: { modes: ['as-loaded'], nominalCutoffV: null, reaim: { h: 3, v: 2 } } });
    expect(() => evaluateWithAim(spot, reg, { mode: 're-aim-search' })).toThrow(EngineError);
  });

  it('aim to cut-off needs the nominal cut-off V from the file', () => {
    expect(() => evaluateWithAim(spot, testReg(), { mode: 'aim-to-cutoff' })).toThrow(/nominal cut-off V/);
  });

  it('aim to cut-off first, at the regulation’s nominal V (Phase 5)', () => {
    const fine = parseIes(fixture('cutoff-plain-fine.ies'), { name: 'fine' }).dataset;
    const reg = testReg({ aim: { modes: ['aim-to-cutoff'], nominalCutoffV: -1, reaim: { h: null, v: null } } });
    const r = evaluateWithAim(fine, reg, { mode: 'aim-to-cutoff', cutoff: { scanH: 0, vMin: -3, vMax: 2, traffic: 'RHT' } });
    expect(Math.abs(r.aim.pitch - (-1 - measuredCut(PLAIN_V0)))).toBeLessThan(0.01);
    expect(Math.abs(scanCutoff(r.dataset, { h: 0, vMin: -3, vMax: 2 }).v + 1)).toBeLessThanOrEqual(0.005);
    expect(r.notes.join(' ')).toMatch(/aimed to cut-off/i);
  });

  it('re-aim search is disabled, with an explanation, when the permitted range is null', () => {
    const reg = testReg({ aim: { modes: ['as-loaded', 're-aim-search'], nominalCutoffV: null, reaim: { h: null, v: 2 } } });
    const r = evaluateWithAim(spot, reg, { mode: 're-aim-search' });
    expect(r.searchDisabledReason).toMatch(/permitted re-aim range.*H/);
    expect(r.optimised).toBeNull();
    expect(r.aim).toEqual({ yaw: 0, pitch: 0 });
  });

  it('re-aim search recovers the known optimum on a mis-aimed spot (within 0.05°), from composed rotations', () => {
    const r = evaluateWithAim(spot, testReg(), { mode: 're-aim-search' });
    expect(r.searchDisabledReason).toBeNull();
    expect(Math.abs(r.aim.yaw + SPOT.h)).toBeLessThan(0.05);
    expect(Math.abs(r.aim.pitch + SPOT.v)).toBeLessThan(0.05);
    const nominalC = r.nominal.elements[0]!;
    const optC = r.optimised!.elements[0]!;
    expect(nominalC.status).toBe('fail'); // 15000 not reached at (0, 0) as loaded
    expect(optC.status).toBe('pass');
    expect(optC.measured!).toBeGreaterThan(0.995 * (SPOT.peak + 100));
    expect(r.result).toBe(r.optimised);
    expect(r.dataset.rotationOf?.source).toBe(spot);
  });

  it('the search never leaves the permitted range', () => {
    const reg = testReg({ aim: { modes: ['re-aim-search'], nominalCutoffV: null, reaim: { h: 1, v: 0.5 } } });
    const r = evaluateWithAim(spot, reg, { mode: 're-aim-search' });
    expect(r.aim.yaw).toBeCloseTo(-1, 6);
    expect(r.aim.pitch).toBeCloseTo(0.5, 6);
  });
});
