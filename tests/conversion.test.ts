import { describe, expect, it } from 'vitest';
import { parseIes } from '../core/io/ies';
import { sample } from '../core/geometry/interpolate';
import { flux } from '../core/geometry/flux';
import { dirTypeA, sameBeam } from './fixtures/generate';
import { fixture } from './load-fixture';

describe('the same physical beam stored as Type A, B and C', () => {
  const A = parseIes(fixture('same-beam-typeA.ies')).dataset;
  const B = parseIes(fixture('same-beam-typeB.ies')).dataset;
  const C = parseIes(fixture('same-beam-typeC.ies')).dataset;

  // Type A (H, V) test directions in the forward hemisphere
  const directions: Array<[number, number]> = [
    [0, 0], [10, 0], [0, 5], [20, 10], [-35, -20], [60, 40], [-75, 15], [5, -70],
  ];

  it.each(directions)('agrees with the analytic beam at H=%d, V=%d within 0.2 percent', (h, v) => {
    const expected = sameBeam(...dirTypeA(h, v));
    for (const ds of [A, B, C]) {
      expect(Math.abs(sample(ds, h, v) / expected - 1), ds.meta.sourceType).toBeLessThan(0.002);
    }
  });

  it('gives the same flux over the forward hemisphere within 0.2%', () => {
    const fa = flux(A);
    expect(Math.abs(flux(B) / fa - 1)).toBeLessThan(0.002);
    // C covers the full sphere; compare its forward hemisphere only
    const hemi = { ...C, coverage: { hMin: -90, hMax: 90, vMin: -90, vMax: 90 } };
    expect(Math.abs(flux(hemi) / fa - 1)).toBeLessThan(0.002);
  });
});
