import { describe, expect, it } from 'vitest';
import golden from './fixtures/road/golden-road-illuminate.json';
import { parseIes } from '../core/io/ies';
import { fixture } from './load-fixture';
import { anglesFromMatrix, type Mat3 } from '../core/geometry/rotate';
import { FACING_VEHICLE, axisValues, makeEvaluator, type RoadLamp } from '../core/road/illuminance';
import { reach, width } from '../core/road/metrics';

/**
 * Golden comparison with the original Road-illuminate calculation.
 *
 * The reference values were generated ONCE by running Road-illuminate's own
 * Python (import/road-illuminate/headlamp_road_illuminance.py, commit in the
 * fixture) with scripts/golden-road-illuminate.py, because CI has neither numpy
 * nor import/. Re-run that script to regenerate them.
 *
 * Conversion from Road-illuminate's frame (x forward, y LEFT, z up) to ours
 * (x forward, y RIGHT, z up): M = diag(1, −1, 1).
 *   position: (x, y, z) → (x, −y, z)
 *   lamp axes (columns forward, left, up) → our R (columns forward, right, up) = M · A · M
 *   aim = anglesFromMatrix(R)  (yaw + right, pitch + up, roll + clockwise)
 * Road-illuminate gives 0 cd outside the data, so we compare with outside: 'zero'.
 */

interface GoldenLamp { name: string; pos: number[]; axes: number[][]; aimV: number; aimH: number; zp: number }
interface GoldenCase {
  label: string;
  args: { method: string; mirror_right: boolean; only: string | null; eval_height: number };
  lamps: GoldenLamp[];
  x: number[];
  y: number[];
  E: number[][];
  range: Record<string, number | null>;
  width: Record<string, [number, number] | null>;
}

const ds = parseIes(fixture('road-beam-typeA.ies')).dataset;
const cases = (golden as unknown as { cases: GoldenCase[] }).cases;

/** Road-illuminate lamp → our lamp. */
function toOurLamp(g: GoldenLamp, c: GoldenCase): RoadLamp {
  const A = g.axes;
  // our R[i][j] = M[i] · A[i][j] · M[j], M = (1, −1, 1)
  const m = [1, -1, 1];
  const R: Mat3 = [];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) R.push(m[i]! * A[i]![j]! * m[j]!);
  const aim = anglesFromMatrix(R);
  if (c.args.method === 'vertical') {
    // HSPR shifts the data by (aimH, aimV) instead of turning the lamp; the closest true rotation is yaw = aimH, pitch = aimV
    // (Road-illuminate aimH = −yaw_left+, i.e. already "positive right").
    aim.yaw += g.aimH;
    aim.pitch += g.aimV;
  }
  return {
    name: g.name,
    dataset: ds,
    position: { x: g.pos[0]!, y: -g.pos[1]!, height: g.pos[2]! },
    aim,
    mirror: g.name === 'right' && c.args.mirror_right,
  };
}

/** Road-illuminate y (left) → our y (right). */
const ourY = (yLeft: number) => (yLeft === 0 ? 0 : -yLeft);

describe('golden comparison with Road-illuminate (road method)', () => {
  it('the fixture comes from Road-illuminate and has the expected cases', () => {
    expect((golden as unknown as { referenceCommit: string }).referenceCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(cases.map((c) => c.args.method)).toEqual(['road', 'road', 'road', 'road', 'vertical']);
  });

  for (const c of cases.filter((k) => k.args.method === 'road')) {
    it(`matches on the road surface: ${c.label}`, () => {
      const ev = makeEvaluator(c.lamps.map((g) => toOurLamp(g, c)), { outside: 'zero' });
      let worst = 0;
      c.y.forEach((y, iy) =>
        c.x.forEach((x, ix) => {
          const ref = c.E[iy]![ix]!;
          const ours = ev([x, ourY(y), 0]);
          // Same formula and bilinear lookup: agreement to rounding of the 3-decimal file values
          expect(Math.abs(ours - ref)).toBeLessThanOrEqual(1e-9 * Math.max(1, ref) + 1e-12);
          worst = Math.max(worst, Math.abs(ours - ref) / Math.max(ref, 1e-9));
        }),
      );
      expect(worst).toBeLessThan(1e-9);
    });
  }
});

describe('golden comparison with Road-illuminate: reach and width (road method)', () => {
  // Road-illuminate samples reach every 0.05 m from 0.05 to 200 m and width every 0.02 m over ±20 m, and reports
  // the last sample that meets the level (no interpolation). beamLab interpolates the crossing, so the two agree
  // within one Road-illuminate step, and beamLab's value is never shorter than Road-illuminate's.
  const xs = axisValues({ min: 0.05, max: 200, step: 0.05 });
  const ys = axisValues({ min: -20, max: 20, step: 0.02 });
  for (const c of cases.filter((k) => k.args.method === 'road')) {
    it(`reach and width agree within one sampling step: ${c.label}`, () => {
      const ev = makeEvaluator(c.lamps.map((g) => toOurLamp(g, c)), { outside: 'zero' });
      for (const [key, ref] of Object.entries(c.range)) {
        const [thr, yLeft] = key.split('@').map(Number) as [number, number];
        const r = reach(ev, ourY(yLeft), xs, thr);
        if (ref === null) expect(r.reach).toBeNull();
        else {
          expect(r.reach! - ref, key).toBeGreaterThanOrEqual(-1e-9);
          expect(r.reach! - ref, key).toBeLessThan(0.05 + 1e-9);
        }
      }
      for (const [key, ref] of Object.entries(c.width)) {
        const [thr, x] = key.split('@').map(Number) as [number, number];
        const w = width(ev, x, ys, thr);
        if (ref === null) expect(w.width).toBeNull();
        else {
          // Road-illuminate (rightmost, leftmost) in its y-left frame → our (from, to) in y-right
          const [from, to] = [-ref[1], -ref[0]];
          expect(from - w.from!, key).toBeGreaterThanOrEqual(-1e-9);
          expect(from - w.from!, key).toBeLessThan(0.02 + 1e-9);
          expect(w.to! - to, key).toBeGreaterThanOrEqual(-1e-9);
          expect(w.to! - to, key).toBeLessThan(0.02 + 1e-9);
        }
      }
    });
  }
});

describe('golden comparison with Road-illuminate (vertical / HSPR method): a documented difference', () => {
  const c = cases.find((k) => k.args.method === 'vertical')!;

  it('vertical planes facing the vehicle agree within the HSPR snapping and data-shift approximation', () => {
    const ev = makeEvaluator(c.lamps.map((g) => toOurLamp(g, c)), { outside: 'zero' });
    const z = c.args.eval_height;
    let worst = 0;
    c.y.forEach((y, iy) =>
      c.x.forEach((x, ix) => {
        const ref = c.E[iy]![ix]!;
        const ours = ev([x, ourY(y), z], FACING_VEHICLE);
        if (ref > 1) worst = Math.max(worst, Math.abs(ours / ref - 1));
      }),
    );
    // HSPR rounds H and V to 0.05° and shifts the data instead of rotating it. Measured worst case on this beam:
    expect(worst).toBeGreaterThan(0); // the methods are not identical
    expect(worst).toBeLessThan(0.05); // measured 3.7 % (x = 5 m, 0.5 m left), the largest angular step per metre

  });
});
