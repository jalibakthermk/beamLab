import { describe, expect, it } from 'vitest';
import { mk } from './helpers';
import {
  FACING_VEHICLE,
  RoadError,
  axisValues,
  illuminanceAt,
  makeEvaluator,
  roadIlluminance,
  verticalIlluminance,
  type RoadLamp,
} from '../core/road/illuminance';
import { rotate } from '../core/geometry/rotate';

const range = (a: number, b: number, s: number) => axisValues({ min: a, max: b, step: s });
const NO_AIM = { yaw: 0, pitch: 0, roll: 0 };
const D2R = Math.PI / 180;

/** Isotropic source: I cd in every direction of the full sphere. */
const iso = (I: number) => mk(range(-180, 180, 10), range(-90, 90, 10), () => I, { name: 'iso' });
const lamp = (dataset: RoadLamp['dataset'], x: number, y: number, height: number, aim = NO_AIM, mirror = false): RoadLamp => ({ dataset, position: { x, y, height }, aim, mirror });

describe('road illuminance: isotropic source', () => {
  const I = 10000;
  const h = 0.65;
  const L = [lamp(iso(I), 0, 0, h)];

  it('E on the road = I·h / (x² + y² + h²)^1.5', () => {
    for (const [x, y] of [[0, 0], [5, 0], [25, 0], [50, 0], [25, 3.5], [10, -2], [100, 7]] as const) {
      const expected = (I * h) / (x * x + y * y + h * h) ** 1.5;
      expect(illuminanceAt(L, [x, y, 0])).toBeCloseTo(expected, 10);
    }
  });

  it('the road grid gives the same values, row-major [y][x]', () => {
    const f = roadIlluminance(L, { x: { min: 0, max: 40, step: 10 }, y: { min: -2, max: 2, step: 2 } });
    expect(f.cols).toEqual([0, 10, 20, 30, 40]);
    expect(f.rows).toEqual([-2, 0, 2]);
    expect(f.unknownFraction).toBe(0);
    const at = (ix: number, iy: number) => f.values[iy * 5 + ix]!;
    expect(at(3, 0)).toBeCloseTo((I * h) / (900 + 4 + h * h) ** 1.5, 10);
    expect(at(1, 1)).toBeCloseTo((I * h) / (100 + h * h) ** 1.5, 10);
  });

  it('a lamp below the plane it faces away from gives nothing (cos θ ≤ 0)', () => {
    expect(illuminanceAt([lamp(iso(I), 0, 0, -0.1)], [10, 0, 0])).toBe(0);
  });
});

describe('road illuminance: two lamps', () => {
  const I = 5000;
  const h = 0.7;
  const L = [lamp(iso(I), 0, -0.7, h), lamp(iso(I), 0, 0.7, h)];
  const one = (x: number, y: number, ly: number) => (I * h) / (x * x + (y - ly) ** 2 + h * h) ** 1.5;

  it('sum is correct on and off the centre line', () => {
    for (const [x, y] of [[20, 0], [20, 1.5], [8, -3], [50, 0.7]] as const) {
      expect(illuminanceAt(L, [x, y, 0])).toBeCloseTo(one(x, y, -0.7) + one(x, y, 0.7), 10);
    }
  });
});

/** Narrow Gaussian spot at (h0, v0), on a fine grid; NaN outside. */
const spot = (h0 = 0, v0 = 0, sigma = 0.02) =>
  mk(range(-3, 3, 0.01), range(-3, 3, 0.01), (h, v) => 1e5 * Math.exp(-((h - h0) ** 2 + (v - v0) ** 2) / (2 * sigma * sigma)), { name: 'spot' });

function argmax(values: ArrayLike<number>): number {
  let best = 0;
  for (let i = 1; i < values.length; i++) if (values[i]! > values[best]!) best = i;
  return best;
}

describe('road illuminance: aim', () => {
  const ds = spot();
  const h = 0.65;

  it('a spot pitched down by v from height h lands at x = h / tan(v)', () => {
    for (const v of [1, 1.5, 2.5]) {
      const L = [lamp(ds, 0, 0, h, { yaw: 0, pitch: -v, roll: 0 })];
      const xLand = h / Math.tan(v * D2R);
      const f = roadIlluminance(L, { x: { min: xLand - 3, max: xLand + 3, step: 0.01 }, y: { min: 0, max: 0, step: 1 } }, { outside: 'zero' });
      expect(Math.abs(f.cols[argmax(f.values)]! - xLand)).toBeLessThan(0.1);
    }
  });

  it('positive yaw moves the spot to the right (+y), negative to the left', () => {
    const v = 1.5;
    const x0 = h / Math.tan(v * D2R);
    for (const yaw of [2, -2]) {
      const L = [lamp(ds, 0, 0, h, { yaw, pitch: -v, roll: 0 })];
      const f = roadIlluminance(L, { x: { min: x0 - 2, max: x0 + 2, step: 0.05 }, y: { min: -3, max: 3, step: 0.01 } }, { outside: 'zero' });
      const i = argmax(f.values);
      const y = f.rows[Math.floor(i / f.cols.length)]!;
      expect(Math.sign(y)).toBe(Math.sign(yaw));
      expect(y).toBeCloseTo(x0 * Math.tan(yaw * D2R), 1);
    }
  });

  it('a mirrored lamp pair with opposite yaw is symmetric about the centre line', () => {
    // Asymmetric beam (spot right of centre plus a wide background)
    const asym = mk(range(-40, 40, 0.5), range(-10, 5, 0.25), (hh, vv) => 200 + 2e4 * Math.exp(-((hh - 4) ** 2) / 50 - ((vv + 1) ** 2) / 2));
    const toe = 1.5;
    const L = [
      lamp(asym, -0.2, 0.75, 0.7, { yaw: toe, pitch: -0.5, roll: 0.3 }),
      lamp(asym, -0.2, -0.75, 0.7, { yaw: -toe, pitch: -0.5, roll: -0.3 }, true),
    ];
    const ev = makeEvaluator(L);
    for (const [x, y] of [[15, 1], [30, 4.2], [60, 2], [25, 0.3]] as const) {
      const a = ev([x, y, 0]);
      expect(Number.isFinite(a)).toBe(true);
      expect(ev([x, -y, 0])).toBeCloseTo(a, 9);
    }
    // ... and not symmetric without the mirror
    const plain = makeEvaluator([L[0]!, { ...L[1]!, mirror: false }]);
    expect(Math.abs(plain([30, 4.2, 0]) / plain([30, -4.2, 0]) - 1)).toBeGreaterThan(0.05);
  });

  it('aiming the lamp equals aiming the dataset with the Phase 4 rotation', () => {
    const ds2 = mk(range(-40, 40, 0.25), range(-15, 10, 0.25), (hh, vv) => 100 + 1e4 * Math.exp(-((hh - 3) ** 2) / 20 - ((vv + 1) ** 2) / 1.5));
    const aim = { yaw: 1.2, pitch: -0.8, roll: 0.5 };
    const rotated = rotate(ds2, aim).dataset;
    const byAim = makeEvaluator([lamp(ds2, 0, 0.6, 0.65, aim)]);
    const byData = makeEvaluator([lamp(rotated, 0, 0.6, 0.65)], { composeRotation: false });
    const composed = makeEvaluator([lamp(rotated, 0, 0.6, 0.65)]);
    for (const [x, y] of [[20, 0], [40, 2], [12, -1.5], [60, 3]] as const) {
      const a = byAim([x, y, 0]);
      expect(composed([x, y, 0])).toBeCloseTo(a, 9); // same matrix, same source: exact
      expect(Math.abs(byData([x, y, 0]) / a - 1)).toBeLessThan(0.02); // resampled once more: interpolation error only
    }
  });
});

describe('vertical planes and single points', () => {
  const I = 8000;
  const h = 0.65;
  const L = [lamp(iso(I), 0, 0.5, h)];

  it('vertical plane facing the vehicle: E = I·Δx / r³', () => {
    const [x, y, z] = [25, 2, 1.0];
    const r = Math.hypot(x, y - 0.5, z - h);
    expect(illuminanceAt(L, [x, y, z], FACING_VEHICLE)).toBeCloseTo((I * x) / r ** 3, 10);
    const f = verticalIlluminance(L, { x, y: { min: 0, max: 4, step: 2 }, z: { min: 0, max: 2, step: 1 } });
    expect(f.plane).toBe('vertical');
    expect(f.cols).toEqual([0, 2, 4]);
    expect(f.rows).toEqual([0, 1, 2]);
    expect(f.values[1 * 3 + 1]).toBeCloseTo((I * x) / r ** 3, 10);
  });

  it('a point at any height with a given normal: E = I·cos θ / r²', () => {
    // Upward-facing surface at 0.3 m (below the lamp), tilted 45° normal towards the lamp
    const P = [10, 0.5, 0.3] as const;
    const d = [P[0], P[1] - 0.5, P[2] - h];
    const r = Math.hypot(...d);
    expect(illuminanceAt(L, P, [0, 0, 1])).toBeCloseTo((I * (h - 0.3)) / r ** 3, 10);
    const n = [-Math.SQRT1_2, 0, Math.SQRT1_2] as const;
    const cos = -(d[0]! * n[0] + d[2]! * n[2]) / r;
    expect(illuminanceAt(L, P, n)).toBeCloseTo((I * cos) / (r * r), 10);
    // a normal that does not need to be unit length
    expect(illuminanceAt(L, P, [-2, 0, 2])).toBeCloseTo((I * cos) / (r * r), 10);
  });
});

describe('coverage', () => {
  // Data only for H -10..10, V -5..5 (constant 1000 cd)
  const ds = mk(range(-10, 10, 1), range(-5, 5, 1), () => 1000);
  const L = [lamp(ds, 0, 0, 1)];
  const grid = { x: { min: 0, max: 30, step: 1 }, y: { min: -5, max: 5, step: 1 } };

  it('a ray outside the data makes the point unknown, and the share is reported', () => {
    const f = roadIlluminance(L, grid);
    // Inside coverage: V ≥ −5° needs horizontal distance ≥ 1 / tan 5°; |H| ≤ 10° needs |y| ≤ x·tan 10°.
    let expectedUnknown = 0;
    f.rows.forEach((y, iy) =>
      f.cols.forEach((x, ix) => {
        const inside = Math.hypot(x, y) >= 1 / Math.tan(5 * D2R) - 1e-9 && Math.abs(y) <= x * Math.tan(10 * D2R) + 1e-9;
        const e = f.values[iy * f.cols.length + ix]!;
        if (inside) expect(e).toBeCloseTo(1000 / (x * x + y * y + 1) ** 1.5, 10);
        else {
          expect(e).toBeNaN();
          expectedUnknown++;
        }
      }),
    );
    expect(expectedUnknown).toBeGreaterThan(0);
    expect(f.unknownCount).toBe(expectedUnknown);
    expect(f.unknownFraction).toBeCloseTo(expectedUnknown / (31 * 11), 12);
    expect(f.outside).toBe('unknown');
  });

  it('treat-as-zero gives 0 there and the same values elsewhere', () => {
    const a = roadIlluminance(L, grid);
    const b = roadIlluminance(L, grid, { outside: 'zero' });
    expect(b.unknownCount).toBe(0);
    expect(b.outside).toBe('zero');
    a.values.forEach((v, i) => expect(b.values[i]).toBe(Number.isNaN(v) ? 0 : v));
  });

  it('with two lamps, one lamp outside its data makes the sum unknown (not a partial sum)', () => {
    const two = [lamp(ds, 0, 0, 1), lamp(iso(1000), 0, 0, 1)];
    expect(illuminanceAt(two, [5, 0, 0])).toBeNaN();
    expect(illuminanceAt(two, [5, 0, 0], undefined, { outside: 'zero' })).toBeCloseTo(1000 / 26 ** 1.5, 10);
  });
});

describe('input checks and size guard', () => {
  it('rejects grids over the size limit and bad steps', () => {
    const L = [lamp(iso(1), 0, 0, 1)];
    expect(() => roadIlluminance(L, { x: { min: 0, max: 1000, step: 0.01 }, y: { min: -50, max: 50, step: 0.01 } })).toThrow(RoadError);
    expect(() => roadIlluminance(L, { x: { min: 0, max: 10, step: 1 }, y: { min: 0, max: 10, step: 1 } }, { maxPoints: 100 })).toThrow(/more than the limit/);
    expect(() => roadIlluminance(L, { x: { min: 0, max: 10, step: 0 }, y: { min: 0, max: 1, step: 1 } })).toThrow(/step must be positive/);
  });

  it('rejects non-intensity datasets, missing values and empty lamp lists', () => {
    const ratio = mk([0, 1], [0, 1], () => 1, { kind: 'ratio' });
    expect(() => illuminanceAt([lamp(ratio, 0, 0, 1)], [1, 0, 0])).toThrow(/intensity/);
    expect(() => illuminanceAt([lamp(iso(1), 0, 0, Number.NaN)], [1, 0, 0])).toThrow(/height must be a number/);
    expect(() => illuminanceAt([], [1, 0, 0])).toThrow(/no lamps/);
  });

  it('axis values include the end when it lies on the step', () => {
    expect(axisValues({ min: -0.3, max: 0.3, step: 0.1 })).toEqual([-0.3, -0.2, -0.1, 0, 0.1, 0.2, 0.3]);
    expect(axisValues({ min: 0, max: 1, step: 0.3 })).toEqual([0, 0.3, 0.6, 0.9]);
  });
});

describe('core/road can be extracted', () => {
  const src = import.meta.glob<string>('../core/road/*.ts', { query: '?raw', import: 'default', eager: true });
  it('imports only from core/road, core/model and core/geometry', () => {
    expect(Object.keys(src).length).toBeGreaterThan(0);
    for (const [file, code] of Object.entries(src)) {
      for (const m of code.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)) {
        expect(m[1], file).toMatch(/^\.\/|^\.\.\/(model|geometry)\//);
      }
    }
  });
});
