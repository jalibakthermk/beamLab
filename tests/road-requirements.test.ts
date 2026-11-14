import { describe, expect, it } from 'vitest';
import { mk } from './helpers';
import { axisValues, makeEvaluator, type RoadLamp } from '../core/road/illuminance';
import { RequirementsError, evaluateRequirements, parseRequirements, requirementsToCsv, type RoadRequirements } from '../core/road/requirements';

const files = import.meta.glob<unknown>('../data/requirements/*.json', { import: 'default', eager: true });

const I = 10000;
const h = 1;
const iso = mk(axisValues({ min: -180, max: 180, step: 10 }), axisValues({ min: -90, max: 90, step: 10 }), () => I);
const lamp: RoadLamp = { dataset: iso, position: { x: 0, y: 0, height: h }, aim: { yaw: 0, pitch: 0, roll: 0 } };
const lines = { 'vehicle-axis': 0, 'lane-centre': 0, 'lane-left-edge': -1.75, 'lane-right-edge': 1.75 };
const ctx = (lamps: RoadLamp[] = [lamp], outside: 'unknown' | 'zero' = 'unknown') => ({
  evaluate: makeEvaluator(lamps, { outside }),
  lines,
  reachX: { min: 0, max: 150, step: 0.1 },
  widthY: { min: -20, max: 20, step: 0.02 },
});
/** Closed-form values for the isotropic lamp. */
const E = (x: number, y: number) => (I * h) / (x * x + y * y + h * h) ** 1.5;
const reachAt = (level: number, y: number) => Math.sqrt(((I * h) / level) ** (2 / 3) - y * y - h * h);

const spec = (elements: unknown[]): RoadRequirements =>
  parseRequirements({ id: 'test', title: 'Test', source: null, revision: null, verified: false, elements });

describe('requirements file validation', () => {
  it('the template in data/requirements/ is valid and has only null values', () => {
    const entries = Object.entries(files);
    expect(entries.map(([f]) => f)).toContain('../data/requirements/template.json');
    for (const [f, obj] of entries) if (!f.endsWith('/schema.json')) parseRequirements(obj);
    const t = parseRequirements(files['../data/requirements/template.json']);
    expect(t.verified).toBe(false);
    expect(t.elements.map((e) => e.type).sort()).toEqual(['point', 'point', 'reach', 'width']);
    const numbers = JSON.stringify(files['../data/requirements/template.json']).match(/:\s*-?\d/g);
    expect(numbers).toBeNull();
  });

  it('lists every problem with its path', () => {
    try {
      parseRequirements({ id: 1, title: 'x', verified: false, elements: [{ type: 'reach', name: 'r', line: 'nowhere', level: 'a', min: null }, { type: 'zone' }] });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(RequirementsError);
      const p = (e as RequirementsError).problems;
      expect(p).toContain('id: must be a string');
      expect(p).toContain('elements[0].line: must be one of vehicle-axis, lane-centre, lane-left-edge, lane-right-edge');
      expect(p).toContain('elements[0].level: must be a number or null');
      expect(p.some((x) => x.startsWith('elements[1].type'))).toBe(true);
    }
  });

  it('rejects duplicate names and a point plane that is not road, vertical or a normal', () => {
    expect(() => spec([{ type: 'width', name: 'a', x: 1, level: 1, min: 1 }, { type: 'width', name: 'a', x: 2, level: 1, min: 1 }])).toThrow(/duplicate/);
    expect(() => spec([{ type: 'point', name: 'p', x: 1, y: 0, z: 0, plane: 'tilted', min: 1 }])).toThrow(/plane/);
  });
});

describe('requirements evaluation (isotropic lamp, hand-computed)', () => {
  it('point: min and max on the road and on a vertical plane, with margins', () => {
    const r = evaluateRequirements(
      spec([
        { type: 'point', name: 'road 20 m', x: 20, y: 0, z: 0, plane: 'road', min: 1 },
        { type: 'point', name: 'road 20 m max', x: 20, y: 0, z: 0, plane: 'road', max: 1 },
        { type: 'point', name: 'sign', x: 25, y: 2, z: 1, plane: 'vertical', min: 10 },
        { type: 'point', name: 'normal up at 0.5 m', x: 10, y: 0, z: 0.5, plane: { normal: [0, 0, 1] }, min: 4 },
      ]),
      ctx(),
    );
    const [a, b, c, d] = r.elements;
    expect(a!.measured).toBeCloseTo(E(20, 0), 10);
    expect(a!.status).toBe('pass');
    expect(a!.margin).toBeCloseTo(E(20, 0) - 1, 10);
    expect(a!.marginPercent).toBeCloseTo((E(20, 0) - 1) * 100, 8);
    expect(b!.status).toBe('fail');
    expect(b!.margin).toBeCloseTo(1 - E(20, 0), 10);
    const rr = Math.hypot(25, 2, 0);
    expect(c!.measured).toBeCloseTo((I * 25) / rr ** 3, 10);
    expect(c!.status).toBe('pass');
    expect(d!.measured).toBeCloseTo((I * 0.5) / Math.hypot(10, 0.5) ** 3, 10);
    expect(d!.status).toBe('pass');
    expect(r.overall).toBe('fail');
    expect(r.counts).toEqual({ pass: 3, fail: 1, notEvaluated: 0 });
    expect(r.worst).toBe('road 20 m max');
  });

  it('reach: minimum distance on a named line', () => {
    const r = evaluateRequirements(
      spec([
        { type: 'reach', name: 'centre 1 lx ≥ 20 m', line: 'lane-centre', level: 1, min: 20 },
        { type: 'reach', name: 'edge 3 lx ≥ 70 m', line: 'lane-right-edge', level: 3, min: 70 },
      ]),
      ctx(),
    );
    expect(r.elements[0]!.measured!).toBeCloseTo(reachAt(1, 0), 1);
    expect(r.elements[0]!.status).toBe('pass');
    expect(r.elements[1]!.measured!).toBeCloseTo(reachAt(3, 1.75), 1);
    expect(r.elements[1]!.status).toBe('fail');
    expect(r.elements[1]!.margin!).toBeCloseTo(reachAt(3, 1.75) - 70, 1);
  });

  it('width: minimum width at a distance for a level', () => {
    const half = Math.sqrt(((I * h) / 2) ** (2 / 3) - 15 * 15 - h * h);
    const r = evaluateRequirements(spec([{ type: 'width', name: 'w', x: 15, level: 2, min: 20 }]), ctx());
    expect(r.elements[0]!.measured!).toBeCloseTo(2 * half, 1);
    expect(r.elements[0]!.status).toBe(2 * half >= 20 ? 'pass' : 'fail');
  });

  it('a missing value in the file is "not evaluated", never a pass', () => {
    const r = evaluateRequirements(
      spec([
        { type: 'point', name: 'p', x: 20, y: 0, z: 0, plane: 'road', min: null },
        { type: 'reach', name: 'r', line: 'lane-centre', level: null, min: 50 },
        { type: 'width', name: 'w', x: null, level: 1, min: 5 },
      ]),
      ctx(),
    );
    expect(r.elements.map((e) => e.status)).toEqual(['not-evaluated', 'not-evaluated', 'not-evaluated']);
    expect(r.elements[0]!.reason).toMatch(/no limit/);
    expect(r.overall).toBe('incomplete');
  });
});

describe('unknown areas never count as a pass', () => {
  // Data only for H −20..20, V −10..5
  const limited: RoadLamp = { ...lamp, dataset: mk(axisValues({ min: -20, max: 20, step: 1 }), axisValues({ min: -10, max: 5, step: 1 }), () => I) };

  it('point outside the data: not evaluated; with treat-as-zero it is evaluated as 0', () => {
    const s = spec([{ type: 'point', name: 'near', x: 2, y: 0, z: 0, plane: 'road', max: 1e9 }]);
    expect(evaluateRequirements(s, ctx([limited])).elements[0]).toMatchObject({ status: 'not-evaluated', measured: null });
    expect(evaluateRequirements(s, ctx([limited], 'zero')).elements[0]).toMatchObject({ status: 'pass', measured: 0 });
  });

  it('width where the area runs into unknown: a min that is not met is not evaluated; a met min passes on known data', () => {
    // At x = 10 the data stops at |y| = 10·tan 20° = 3.64 m; E there is still far above 1 lx
    const r = evaluateRequirements(
      spec([
        { type: 'width', name: 'needs 10 m', x: 10, level: 1, min: 10 },
        { type: 'width', name: 'needs 5 m', x: 10, level: 1, min: 5 },
      ]),
      ctx([limited]),
    );
    expect(r.elements[0]!.status).toBe('not-evaluated');
    expect(r.elements[0]!.reason).toMatch(/unknown/);
    expect(r.elements[1]!.status).toBe('pass');
  });

  it('reach with a maximum: unknown or beyond the evaluated range is not evaluated', () => {
    const s = spec([{ type: 'reach', name: 'max 500', line: 'lane-centre', level: 0.001, max: 500 }]);
    const res = evaluateRequirements(s, ctx());
    expect(res.elements[0]!.status).toBe('not-evaluated');
    expect(res.elements[0]!.reason).toMatch(/end of the evaluated range/);
  });

  it('multiple crossings are flagged on the result', () => {
    // Two lamps far apart along x: a dip between them on the centre line
    const far: RoadLamp = { ...lamp, position: { x: 60, y: 0, height: h } };
    const r = evaluateRequirements(spec([{ type: 'reach', name: 'r', line: 'lane-centre', level: 1, min: 10 }]), ctx([lamp, far]));
    expect(r.elements[0]!.flags).toContain('multiple crossings');
    expect(r.elements[0]!.crossings!.length).toBeGreaterThan(1);
    expect(r.elements[0]!.status).toBe('pass');
  });
});

describe('CSV', () => {
  it('one row per element with status and margin', () => {
    const r = evaluateRequirements(spec([{ type: 'point', name: 'a, "b"', x: 20, y: 0, z: 0, plane: 'road', min: 1 }]), ctx());
    const lines = requirementsToCsv(r).trim().split('\n');
    expect(lines[0]).toBe('element,type,status,measured,unit,limit_kind,limit,margin,margin_percent,flags,reference,reason');
    expect(lines[1]).toMatch(/^"a, ""b""",point,pass,1\.245\d*,lx,min,1,/);
  });
});
