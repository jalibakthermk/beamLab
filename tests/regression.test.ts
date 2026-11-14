import { describe, expect, it } from 'vitest';
import { parseIes } from '../core/io/ies';
import { bilinear, sample } from '../core/geometry/interpolate';
import { anglesToVector, vectorToAngles } from '../core/geometry/coords';
import { summarize } from '../core/analysis/summary';
import { FINE_CUTOFF, fineCutoffCd } from './fixtures/generate';
import { fixture } from './load-fixture';

/**
 * Regression for the value mismatch found with a real Type B file (end of Phase 2):
 * the Type B -> Type A conversion was coarsened from 0.1° to 0.15625° because the
 * grid-size limit was applied to the full sphere, which lowered the peak by ~5%.
 */
describe('regression: Type B file with a 0.1° cut-off band keeps its resolution', () => {
  const { dataset, warnings, stages } = parseIes(fixture('fine-cutoff-typeB.ies'));

  it('is converted at the file’s own 0.1° step, with no coarsening warning', () => {
    expect(warnings.map((w) => w.code)).not.toContain('RESAMPLE_STEP_COARSENED');
    const conversion = dataset.provenance?.params['conversion'] as Record<string, unknown>;
    expect(conversion['targetStep']).toBe(0.1);
  });

  it('keeps the peak within 0.05% of the file node value (the bug lost ~5%)', () => {
    const fileNode = Number(fineCutoffCd(FINE_CUTOFF.h0, FINE_CUTOFF.v0).toFixed(2));
    const s = summarize(dataset);
    expect(s.maxAt).toEqual({ h: FINE_CUTOFF.h0, v: FINE_CUTOFF.v0 });
    expect(Math.abs(s.maxIntensity / fileNode - 1)).toBeLessThan(0.0005);
  });

  it.each([
    [0, 0],
    [5, -0.8],
    [2, -0.6],
    [-12.3, -2.1],
  ])('sample(%d, %d) equals bilinear interpolation on the original Type B grid', (h, v) => {
    const b = vectorToAngles('B', anglesToVector('A', h, v));
    const direct = bilinear(stages.source.h, stages.source.v, stages.source.values, b.h, b.v);
    expect(Math.abs(sample(dataset, h, v) / direct - 1)).toBeLessThan(1e-9);
  });
});
