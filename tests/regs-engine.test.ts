import { describe, expect, it } from 'vitest';
import { EngineError, evaluateRegulation, geometryOutline, nearestElement, resultsToCsv, type ElementResult, type RegulationResult } from '../core/regs/engine';
import { parseRegulation, type Regulation } from '../core/regs/schema';
import { range } from './fixtures/generate';
import { mk } from './helpers';
import TEST from './fixtures/regs/TEST-invented-values.json';

/**
 * Field I = 3000 + 100·H + 50·V on a 1° grid (H -10..10, V -5..5): bilinear is exact,
 * so every expected value below is a hand calculation.
 */
const plane = (h: number, v: number) => 3000 + 100 * h + 50 * v;
const DS = mk(range(-10, 10, 1), range(-5, 5, 1), plane, { name: 'plane' });
const reg = parseRegulation(TEST);
const el = (r: RegulationResult, name: string) => r.elements.find((e) => e.name === name)!;
const variant = (patch: (o: Record<string, unknown> & { elements: Array<Record<string, unknown>> }) => void): Regulation => {
  const o = JSON.parse(JSON.stringify(TEST));
  patch(o);
  return parseRegulation(o);
};
function expectEl(e: ElementResult, measured: number, limit: number, kind: 'min' | 'max', status: string) {
  expect(e.measured).toBeCloseTo(measured, 6);
  expect(e.limit).toEqual({ kind, value: expect.closeTo(limit, 6) });
  const margin = kind === 'min' ? measured - limit : limit - measured;
  expect(e.margin).toBeCloseTo(margin, 6);
  expect(e.marginPercent).toBeCloseTo((100 * margin) / limit, 6);
  expect(e.status).toBe(status);
}

describe('regulation engine: every element type, hand-computed', () => {
  const r = evaluateRegulation(DS, reg);

  it('point: sampled value against an absolute minimum', () => {
    expectEl(el(r, 'P'), 3175, 3000, 'min', 'pass');
    expect(el(r, 'P').at).toEqual({ h: 2.5, v: -1.5 });
    expect(el(r, 'P').ref).toBe('invented table 1');
  });

  it('point: percentage of a named parameter (80% of Iref 4000 = 3200)', () => {
    expectEl(el(r, 'Q'), 3000, 3200, 'min', 'fail');
  });

  it('point with search radius: the most favourable value within 1° counts (3000 + √(100² + 50²))', () => {
    const e = el(r, 'R1');
    expect(e.measured).toBeCloseTo(3000 + Math.hypot(100, 50), 1);
    expect(e.status).toBe('pass');
    expect(Math.hypot(e.at!.h, e.at!.v)).toBeCloseTo(1, 2);
  });

  it('point: percentage of another element (90% of Q = 2700): margin exactly 0 is a pass', () => {
    expectEl(el(r, 'P90'), 2700, 2700, 'min', 'pass');
  });

  it('point: percentage of the measured maximum (50% of 4250 = 2125)', () => {
    expectEl(el(r, 'Pmax'), 2500, 2125, 'min', 'pass');
  });

  it('line: minimum along the whole segment, with its position', () => {
    expectEl(el(r, 'L'), 2600, 2500, 'min', 'pass');
    expect(el(r, 'L').at).toEqual({ h: -4, v: 0 });
  });

  it('zone: "max anywhere" and "min anywhere" with positions', () => {
    expectEl(el(r, 'Zmax'), 3300, 3400, 'max', 'pass');
    expect(el(r, 'Zmax').at).toEqual({ h: 2, v: 2 });
    expectEl(el(r, 'Zmin'), 2700, 2800, 'min', 'fail');
    expect(el(r, 'Zmin').at).toEqual({ h: -2, v: -2 });
  });

  it('ratio: P/Q = 3175/3000 against min 1.05 and max 1.2; the closer limit binds', () => {
    expectEl(el(r, 'P/Q'), 3175 / 3000, 1.05, 'min', 'pass');
    expect(el(r, 'P/Q').limits).toEqual({ min: 1.05, max: 1.2 });
  });

  it('global: maximum of the whole distribution (4250 at H 10, V 5)', () => {
    expectEl(el(r, 'Imax'), 4250, 4100, 'max', 'fail');
    expect(el(r, 'Imax').at).toEqual({ h: 10, v: 5 });
  });

  it('an element without a limit is not evaluated (value still reported), never a pass', () => {
    const e = el(r, 'NoLimit');
    expect(e.status).toBe('not-evaluated');
    expect(e.reason).toMatch(/no limit/i);
    expect(e.measured).toBeCloseTo(3150, 9);
  });

  it('overall: incomplete when anything is not evaluated; worst margin element; counts', () => {
    expect(r.overall).toBe('incomplete');
    expect(r.worst).toBe('Q');
    expect(r.counts).toEqual({ pass: 7, fail: 3, notEvaluated: 1 });
    expect(r.regulation).toMatchObject({ id: 'TEST-invented-values', verified: false });
  });

  it('overall pass and fail', () => {
    const only = (name: string) => variant((o) => (o.elements = o.elements.filter((e) => e['name'] === name)));
    expect(evaluateRegulation(DS, only('P')).overall).toBe('pass');
    expect(evaluateRegulation(DS, only('Zmin')).overall).toBe('fail');
  });
});

describe('test conditions, units and traffic side', () => {
  it('scale factor and number of lamps multiply the measured values and are stated in the result', () => {
    const r = evaluateRegulation(DS, reg, { scaleFactor: 0.9, lamps: 2 });
    expect(r.conditions).toMatchObject({ scaleFactor: 0.9, lamps: 2, factor: 1.8, traffic: 'RHT', mirrored: false, units: 'cd' });
    expectEl(el(r, 'P'), 3175 * 1.8, 3000, 'min', 'pass');
    expectEl(el(r, 'P90'), 2700 * 1.8, 0.9 * 3000 * 1.8, 'min', 'pass'); // percentage of a scaled element scales too
    expect(el(r, 'Imax').measured).toBeCloseTo(4250 * 1.8, 6);
    expect(() => evaluateRegulation(DS, reg, { scaleFactor: -1 })).toThrow(EngineError);
    expect(() => evaluateRegulation(DS, reg, { lamps: 0 })).toThrow(EngineError);
  });

  it('lx@25m limits and parameters are converted with cd = lx × 625; ratio limits are not', () => {
    const lx = variant((o) => {
      o['units'] = 'lx@25m';
      o.elements[0]!['min'] = 5;
    });
    const r = evaluateRegulation(DS, lx);
    expect(r.conditions.units).toBe('lx@25m');
    expectEl(el(r, 'P'), 3175, 3125, 'min', 'pass');
    expect(el(r, 'Q').limit?.value).toBeCloseTo(0.8 * 4000 * 625, 6);
    expect(el(r, 'P/Q').limits).toEqual({ min: 1.05, max: 1.2 });
  });

  it('left-hand traffic mirrors every element in H when the file allows it', () => {
    const r = evaluateRegulation(DS, reg, { traffic: 'LHT' });
    expect(r.conditions.mirrored).toBe(true);
    expectEl(el(r, 'P'), 2675, 3000, 'min', 'fail');
    expect(el(r, 'P').at).toEqual({ h: -2.5, v: -1.5 });
    expect(el(r, 'L').measured).toBeCloseTo(2700, 9); // segment (4,0)-(-4,2): minimum at (-4, 2)
    expect(el(r, 'L').geometry).toEqual({ kind: 'line', from: [4, 0], to: [-4, 2] });
  });

  it('refuses to mirror when the file does not allow it', () => {
    const noMirror = variant((o) => (o['mirrorForLeftHandTraffic'] = false));
    expect(() => evaluateRegulation(DS, noMirror, { traffic: 'LHT' })).toThrow(/does not allow mirroring/);
  });

  it('accepts only intensity datasets', () => {
    expect(() => evaluateRegulation({ ...DS, kind: 'difference' }, reg)).toThrow(/intensity/);
  });
});

describe('not evaluated: never a pass', () => {
  const small = (elements: unknown[]) =>
    parseRegulation({ ...JSON.parse(JSON.stringify(TEST)), elements });

  it('point outside coverage, zone and line partly outside, missing position, NaN in the data', () => {
    const r = evaluateRegulation(
      mk(range(-10, 10, 1), range(-5, 5, 1), (h, v) => (h === -9 && v === -4 ? NaN : plane(h, v))),
      small([
        { type: 'point', name: 'out', h: 20, v: 0, min: 1 },
        { type: 'zone', name: 'zPart', polygon: [[8, 0], [12, 0], [12, 2], [8, 2]], max: 1e9 },
        { type: 'line', name: 'lPart', from: [5, 0], to: [15, 0], min: 1 },
        { type: 'point', name: 'noPos', h: null, v: 1, min: 1 },
        { type: 'point', name: 'nanNear', h: -8.5, v: -3.5, min: 1 },
        { type: 'point', name: 'ok', h: 0, v: 0, min: 1 },
        { type: 'point', name: 'pctOfOut', h: 0, v: 0, min: { percent: 50, of: { element: 'out' } } },
        { type: 'ratio', name: 'rOut', a: 'ok', b: 'out', min: 0 },
      ]),
    );
    const st = (n: string) => el(r, n);
    expect(st('out').status).toBe('not-evaluated');
    expect(st('out').reason).toMatch(/outside|no data/i);
    expect(st('zPart').status).toBe('not-evaluated');
    expect(st('lPart').status).toBe('not-evaluated');
    expect(st('noPos').reason).toMatch(/position/i);
    expect(st('nanNear').status).toBe('not-evaluated');
    expect(st('ok').status).toBe('pass');
    expect(st('pctOfOut').status).toBe('not-evaluated');
    expect(st('rOut').status).toBe('not-evaluated');
    expect(r.overall).toBe('incomplete');
    expect(r.worst).toBe('ok');
  });
});

describe('outputs', () => {
  const r = evaluateRegulation(DS, reg);

  it('CSV of the results table', () => {
    const lines = resultsToCsv(r).trim().split('\n');
    expect(lines[0]).toBe('element,type,status,measured,limit_kind,limit,margin,margin_percent,H,V,reference,reason');
    expect(lines).toHaveLength(12);
    expect(lines[1]).toBe('P,point,pass,3175,min,3000,175,5.833333,2.5,-1.5,invented table 1,');
    expect(lines.find((l) => l.startsWith('NoLimit'))).toMatch(/^NoLimit,point,not-evaluated,3150,,,,,1,1,,no limit/);
  });

  it('geometryOutline gives drawable polylines (closed zones and search circles)', () => {
    expect(geometryOutline(el(r, 'Zmax').geometry)).toEqual({ h: [-2, 2, 2, -2, -2], v: [-2, -2, 2, 2, -2] });
    expect(geometryOutline(el(r, 'P').geometry)).toEqual({ h: [2.5], v: [-1.5] });
    const c = geometryOutline(el(r, 'R1').geometry, 4);
    expect(c.h.map((x) => Number(x.toFixed(9)) + 0)).toEqual([1, 0, -1, 0, 1]);
  });

  it('nearestElement finds the element under the pointer (point, line, zone), or nothing', () => {
    expect(nearestElement(r, 2.6, -1.4, 0.5)).toBe('P');
    expect(nearestElement(r, 0, 1.0, 0.1)).toBe('L'); // on the segment (-4,0)-(4,2) at H 0
    expect(nearestElement(r, 1.5, -1.8, 0.05)).toBe('Zmax'); // inside the square, away from points and the line
    expect(nearestElement(r, 9, -4.5, 0.3)).toBeNull();
  });
});
