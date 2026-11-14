import { describe, expect, it } from 'vitest';
import { mk } from './helpers';
import { axisValues, makeEvaluator, roadIlluminance, type RoadLamp } from '../core/road/illuminance';
import { checkLevels, crossings, fieldMax, reach, reachOnProfile, width, widthOnProfile } from '../core/road/metrics';

const iso = (I: number) => mk(axisValues({ min: -180, max: 180, step: 10 }), axisValues({ min: -90, max: 90, step: 10 }), () => I);
const lamp = (I: number, y: number, h: number): RoadLamp => ({ dataset: iso(I), position: { x: 0, y, height: h }, aim: { yaw: 0, pitch: 0, roll: 0 } });

describe('crossings and reach on a profile (hand-computed)', () => {
  const p = { s: [0, 10, 20, 30, 40, 50], e: [10, 8, 4, 6, 2, 1] };

  it('a curve that crosses the level three times: all crossings reported and flagged', () => {
    expect(crossings(p, 5)).toEqual([
      { at: 17.5, direction: 'down' },
      { at: 25, direction: 'up' },
      { at: 32.5, direction: 'down' },
    ]);
    const r = reachOnProfile(p, 5);
    expect(r.reach).toBe(32.5);
    expect(r.multiple).toBe(true);
    expect(r.beyondEnd).toBe(false);
    expect(r.unknownBeyond).toBe(false);
  });

  it('single crossing; level never reached; level held to the end', () => {
    expect(reachOnProfile(p, 9)).toMatchObject({ reach: 5, multiple: false });
    expect(reachOnProfile(p, 20)).toMatchObject({ reach: null, crossings: [] });
    expect(reachOnProfile(p, 0.5)).toMatchObject({ reach: 50, beyondEnd: true });
  });

  it('a sample exactly on the level counts as at or above', () => {
    expect(reachOnProfile({ s: [0, 1, 2], e: [3, 2, 1] }, 2).reach).toBe(1);
  });

  it('unknown samples: no interpolation into them; flagged when beyond the reach', () => {
    const r = reachOnProfile({ s: [0, 10, 20, 30], e: [10, 8, NaN, 1] }, 5);
    expect(r.reach).toBe(10);
    expect(r.unknownBeyond).toBe(true);
    expect(r.unknownCount).toBe(1);
  });
});

describe('reach and width on the road (isotropic lamp, closed form)', () => {
  const I = 10000;
  const h = 1;
  const ev = makeEvaluator([lamp(I, 0, h)]);
  const xs = axisValues({ min: 0, max: 100, step: 0.5 });

  it('reach on a line y: E = I·h / (x² + y² + h²)^1.5 = level', () => {
    for (const [level, y] of [[1, 0], [3, 0], [1, 1.75], [3, -1.75]] as const) {
      const expected = Math.sqrt(((I * h) / level) ** (2 / 3) - y * y - h * h);
      const r = reach(ev, y, xs, level);
      expect(r.reach!).toBeCloseTo(expected, 1);
      expect(r.y).toBe(y);
      expect(r.multiple).toBe(false);
    }
  });

  it('width at distance x: the ±y where E = level', () => {
    const ys = axisValues({ min: -30, max: 30, step: 0.05 });
    const x = 15;
    const level = 2;
    const half = Math.sqrt(((I * h) / level) ** (2 / 3) - x * x - h * h);
    const w = width(ev, x, ys, level);
    expect(w.from!).toBeCloseTo(-half, 2);
    expect(w.to!).toBeCloseTo(half, 2);
    expect(w.width!).toBeCloseTo(2 * half, 2);
    expect(w.multiple).toBe(false);
    expect(w.clipped).toBe(false);
  });

  it('maximum illuminance and its position', () => {
    const f = roadIlluminance([lamp(I, 0.5, h)], { x: { min: 0, max: 20, step: 1 }, y: { min: -2, max: 2, step: 0.5 } });
    expect(fieldMax(f)).toEqual({ value: (I * h) / h ** 3, col: 0, row: 0.5 });
  });
});

describe('width on a profile (hand-computed)', () => {
  it('two separate areas above the level: outer extent, both segments, flagged', () => {
    const w = widthOnProfile({ s: [-4, -2, 0, 2, 4], e: [0, 6, 2, 8, 0] }, 4);
    // up at −4 + 4/6·2 = −2.667; down at −2 + 2/4·2 = −1; up at 0 + 2/6·2 = 0.667; down at 2 + 4/8·2 = 3
    expect(w.segments.map(([a, b]) => [Number(a.toFixed(6)), Number(b.toFixed(6))])).toEqual([[-2.666667, -1], [0.666667, 3]]);
    expect(w.from).toBeCloseTo(-8 / 3, 8);
    expect(w.to).toBe(3);
    expect(w.width).toBeCloseTo(3 + 8 / 3, 8);
    expect(w.multiple).toBe(true);
  });

  it('clipped at the ends of the profile', () => {
    expect(widthOnProfile({ s: [0, 1, 2], e: [5, 5, 1] }, 3)).toMatchObject({ from: 0, to: 1.5, clipped: true });
  });
});

describe('isolux levels', () => {
  it('sorted, positive and unique; anything else is rejected', () => {
    expect(checkLevels([3, 1, 10])).toEqual([1, 3, 10]);
    expect(() => checkLevels([])).toThrow(/at least one/);
    expect(() => checkLevels([1, -2])).toThrow(/positive/);
    expect(() => checkLevels([1, 1])).toThrow(/twice/);
  });
});
