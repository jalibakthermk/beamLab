import { describe, expect, it } from 'vitest';
import {
  anglesToVector,
  AXIS_ASSUMPTIONS,
  vectorToAngles,
  type Vec3,
} from '../core/geometry/coords';
import type { PhotometricType } from '../core/model/dataset';

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

function expectVec(actual: Vec3, expected: Vec3, digits = 12) {
  expect(actual[0]).toBeCloseTo(expected[0], digits);
  expect(actual[1]).toBeCloseTo(expected[1], digits);
  expect(actual[2]).toBeCloseTo(expected[2], digits);
}

/**
 * Anchor directions, vehicle axes [forward, right, up], computed by hand:
 *  straight ahead      (1, 0, 0)
 *  10° right           (cos10°, sin10°, 0)          = (0.984807753012208, 0.17364817766693033, 0)
 *  5° up               (cos5°, 0, sin5°)            = (0.9961946980917455, 0, 0.08715574274765817)
 *  combined A(20R,10U) (cos10 cos20, cos10 sin20, sin10)
 *                                                    = (0.9254165783983234, 0.33682408883346515, 0.17364817766693033)
 * Type B (H = asin(y), V = atan2(z, x)):  combined → H = 19.683498079413685, V = 10.627584138330887
 * Type C (γ = acos(-z), C = atan2(-y, x) mod 360, C = 90 is LEFT):
 *   10° right → C = 350, γ = 90;  5° up → C = 0, γ = 95;  combined → C = 340, γ = 100
 */
const ANCHORS: Array<{
  name: string;
  vec: Vec3;
  A: [number, number];
  B: [number, number];
  C: [number, number];
}> = [
  { name: 'straight ahead', vec: [1, 0, 0], A: [0, 0], B: [0, 0], C: [0, 90] },
  {
    name: '10° right',
    vec: [0.984807753012208, 0.17364817766693033, 0],
    A: [10, 0],
    B: [10, 0],
    C: [350, 90],
  },
  {
    name: '5° up',
    vec: [0.9961946980917455, 0, 0.08715574274765817],
    A: [0, 5],
    B: [0, 5],
    C: [0, 95],
  },
  {
    name: 'combined 20° right, 10° up (Type A)',
    vec: [0.9254165783983234, 0.33682408883346515, 0.17364817766693033],
    A: [20, 10],
    B: [19.683498079413685, 10.627584138330887],
    C: [340, 100],
  },
];

describe('axis assumptions', () => {
  it('each non-Type-A frame is orthonormal and right-handed in the stated order', () => {
    const { B, C } = AXIS_ASSUMPTIONS;
    for (const [a, b, c] of [
      [B.zero, B.hPositive, B.vPositive],
      [C.plane0, C.plane90, C.nadir],
    ] as const) {
      for (const u of [a, b, c]) expect(dot(u, u)).toBeCloseTo(1, 15);
      expect(dot(a, b)).toBe(0);
      expect(dot(a, c)).toBe(0);
      expect(dot(b, c)).toBe(0);
    }
    // B: forward × right = up (right-handed vehicle frame)
    expectVec(cross(B.zero, B.hPositive), B.vPositive);
  });
});

describe.each(['A', 'B', 'C'] as PhotometricType[])('Type %s anchor directions', (type) => {
  it.each(ANCHORS)('$name: angles → vector', (a) => {
    const [h, v] = a[type];
    expectVec(anglesToVector(type, h, v), a.vec);
  });
  it.each(ANCHORS)('$name: vector → angles', (a) => {
    const got = vectorToAngles(type, a.vec);
    expect(got.h).toBeCloseTo(a[type][0], 10);
    expect(got.v).toBeCloseTo(a[type][1], 10);
  });
});

describe('round trips', () => {
  // Away from the poles (V = ±90), where H is undefined.
  const points: Array<[number, number]> = [];
  for (let h = -170; h <= 170; h += 10) for (let v = -80; v <= 80; v += 10) points.push([h, v]);

  it.each(['B', 'C'] as PhotometricType[])('A → %s → A returns the original angles', (type) => {
    for (const [h, v] of points) {
      const other = vectorToAngles(type, anglesToVector('A', h, v));
      const back = vectorToAngles('A', anglesToVector(type, other.h, other.v));
      expect(back.h).toBeCloseTo(h, 9);
      expect(back.v).toBeCloseTo(v, 9);
    }
  });

  it('B → A → B and C → A → C return the original angles', () => {
    for (let h = -85; h <= 85; h += 5) {
      for (let v = -175; v <= 175; v += 5) {
        const a = vectorToAngles('A', anglesToVector('B', h, v));
        const b = vectorToAngles('B', anglesToVector('A', a.h, a.v));
        expect(b.h).toBeCloseTo(h, 9);
        expect(b.v).toBeCloseTo(v, 9);
      }
    }
    for (let c = 0; c < 360; c += 15) {
      for (let g = 5; g <= 175; g += 5) {
        const a = vectorToAngles('A', anglesToVector('C', c, g));
        const back = vectorToAngles('C', anglesToVector('A', a.h, a.v));
        expect(back.h).toBeCloseTo(c, 9);
        expect(back.v).toBeCloseTo(g, 9);
      }
    }
  });

  it('produces unit vectors and normalises non-unit input', () => {
    const d = anglesToVector('B', 33, -47);
    expect(dot(d, d)).toBeCloseTo(1, 14);
    const a = vectorToAngles('A', [2, 0, 0]);
    expect(a).toEqual({ h: 0, v: 0 });
  });

  it('returns C in [0, 360) and handles the poles without NaN', () => {
    const up = vectorToAngles('A', [0, 0, 1]);
    expect(up.v).toBeCloseTo(90, 12);
    expect(Number.isFinite(up.h)).toBe(true);
    const down = vectorToAngles('C', [0, 0, -1]);
    expect(down.v).toBeCloseTo(0, 12);
    expect(down.h).toBeGreaterThanOrEqual(0);
    expect(down.h).toBeLessThan(360);
  });
});
