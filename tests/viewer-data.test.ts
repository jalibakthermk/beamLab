import { describe, expect, it } from 'vitest';
import { createStore } from '../ui/state/store';
import { displayGrid } from '../core/analysis/display';
import { GAUSS, UNIFORM_LIMITED, UNIFORM_SPHERE_CD } from './fixtures/generate';
import { fixture, fixtureNames } from './load-fixture';

/**
 * Loads each synthetic fixture through the same store the UI uses and checks
 * that the dataset reaching the viewer has its peak where the fixture says.
 */

const R = 180 / Math.PI;
// Peak of the "same beam" 2000 + 1000x + 400y + 300z: direction (1000, 400, 300)
const SAME_BEAM_PEAK = { h: Math.atan2(400, 1000) * R, v: Math.asin(300 / Math.hypot(1000, 400, 300)) * R };

type Expectation =
  | { at: { h: number; v: number }; tol?: number }
  | { uniform: number };

const EXPECTED: Record<string, Expectation> = {
  'gaussian-spot-typeA.ies': { at: { h: GAUSS.h0, v: GAUSS.v0 } },
  'asymmetric-typeA.ies': { at: { h: 20, v: 5 }, tol: 1 }, // grid step 2: nodes at V = 4 and 6 tie
  'symmetric-half-typeA.ies': { at: { h: 0, v: 90 } },
  'same-beam-typeA.ies': { at: SAME_BEAM_PEAK, tol: 3 },
  'same-beam-typeB.ies': { at: SAME_BEAM_PEAK, tol: 3 },
  'same-beam-typeC.ies': { at: SAME_BEAM_PEAK, tol: 3 },
  'uniform-limited-typeA.ies': { uniform: UNIFORM_LIMITED.cd },
  'uniform-sphere-typeC.ies': { uniform: UNIFORM_SPHERE_CD },
  // Variants of the small grid: variantCd peaks at H = 10, V = 5
  'format-lm63-1986.ies': { at: { h: 10, v: 5 } },
  'format-lm63-1991.ies': { at: { h: 10, v: 5 } },
  'format-lm63-1995.ies': { at: { h: 10, v: 5 } },
  'format-lm63-2002.ies': { at: { h: 10, v: 5 } },
  'format-lm63-2019.ies': { at: { h: 10, v: 5 } },
  'format-mixed-separators.ies': { at: { h: 10, v: 5 } },
  'format-multiplier-ballast.ies': { at: { h: 10, v: 5 } },
  'format-future-use-factor.ies': { at: { h: 10, v: 5 } },
  'format-tilt-include.ies': { at: { h: 10, v: 5 } },
  'format-tilt-file.ies': { at: { h: 10, v: 5 } },
  'malformed-token-long.ies': { at: { h: 10, v: 5 } },
  'malformed-non-ascending.ies': { at: { h: 10, v: 5 } },
  'malformed-negative-candela.ies': { at: { h: 10, v: 5 } },
  // H = 10 plane and (5, 5) are missing (NaN): highest remaining is (5, 0)
  'malformed-token-short.ies': { at: { h: 5, v: 0 } },
};

describe('datasets reaching the viewer', () => {
  it('every fixture has an expectation', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual(fixtureNames().sort());
  });

  it.each(Object.entries(EXPECTED))('%s has the expected peak', (name, exp) => {
    const store = createStore();
    store.addFiles([{ name, text: fixture(name) }]);
    const entry = store.getState().entries[0]!;
    expect(entry.error).toBeNull();
    expect(store.getState().selectedKey).toBe(entry.key);
    const s = entry.summary!;
    if ('uniform' in exp) {
      expect(s.maxIntensity).toBeCloseTo(exp.uniform, 9);
    } else {
      const tol = exp.tol ?? 0;
      expect(Math.abs(s.maxAt!.h - exp.at.h), 'H').toBeLessThanOrEqual(tol + 1e-9);
      expect(Math.abs(s.maxAt!.v - exp.at.v), 'V').toBeLessThanOrEqual(tol + 1e-9);
    }
  });

  it('the asymmetric hot spot is right (+H) and up (+V) in the plotted matrix too', () => {
    const store = createStore();
    store.addFiles([{ name: 'a.ies', text: fixture('asymmetric-typeA.ies') }]);
    const ds = store.getState().entries[0]!.dataset!;
    for (const scale of ['linear', 'log'] as const) {
      const d = displayGrid(ds, { scale });
      let best = { h: 0, v: 0, z: -Infinity };
      d.z.forEach((row, iv) => row.forEach((z, ih) => z !== null && z > best.z && (best = { h: d.h[ih]!, v: d.v[iv]!, z })));
      expect(best.h).toBe(20);
      expect(best.v).toBeGreaterThan(0);
      // Plotly draws z[0] at the lowest V and x ascending to the right: rows must be V ascending
      expect(d.v[0]).toBeLessThan(d.v.at(-1)!);
      expect(d.h[0]).toBeLessThan(d.h.at(-1)!);
    }
  });
});
