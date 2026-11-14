import { describe, expect, it } from 'vitest';
import { IesParseError, parseIes, type IesWarning } from '../core/io/ies';
import { sample } from '../core/geometry/interpolate';
import { vectorToAngles } from '../core/geometry/coords';
import type { PhotometricDataset } from '../core/model/dataset';
import {
  asymmetricCd,
  dirTypeC,
  FUTURE_USE_FACTOR,
  halfSymmetricCd,
  MULTIPLIER_CASE,
  range,
  UNIFORM_LIMITED,
  VARIANT_H,
  VARIANT_V,
  variantCd,
  writeIes,
} from './fixtures/generate';
import { fixture } from './load-fixture';

const codes = (w: IesWarning[]) => w.map((x) => x.code);

function expectVariantValues(ds: PhotometricDataset, tol = 1e-9) {
  expect(ds.grid).toEqual({ h: VARIANT_H, v: VARIANT_V });
  for (const v of VARIANT_V) for (const h of VARIANT_H) expect(sample(ds, h, v)).toBeCloseTo(variantCd(h, v), -Math.log10(tol));
}

function expectThrowCode(text: string, code: string) {
  try {
    parseIes(text);
  } catch (e) {
    expect(e).toBeInstanceOf(IesParseError);
    expect((e as IesParseError).code).toBe(code);
    return;
  }
  throw new Error(`expected IesParseError ${code}`);
}

describe('format detection and keywords', () => {
  it.each([
    ['format-lm63-1986.ies', 'LM-63-1986'],
    ['format-lm63-1991.ies', 'LM-63-1991'],
    ['format-lm63-1995.ies', 'LM-63-1995'],
    ['format-lm63-2002.ies', 'LM-63-2002'],
    ['format-lm63-2019.ies', 'LM-63-2019'],
    ['format-mixed-separators.ies', 'LM-63-2002'],
  ])('%s is read as %s with the expected grid and candela', (file, format) => {
    const { dataset, warnings } = parseIes(fixture(file));
    expect(dataset.meta.sourceFormat).toBe(format);
    expect(dataset.meta.sourceType).toBe('A');
    expect(dataset.kind).toBe('intensity');
    expectVariantValues(dataset);
    // Small grid is smaller than the LM-63 standard range: only that info warning
    expect(codes(warnings)).toEqual(['RANGE_SMALLER_THAN_STANDARD']);
  });

  it('keeps LM-63-1986 free-text lines as LABEL keywords and reads lumens', () => {
    const { dataset } = parseIes(fixture('format-lm63-1986.ies'));
    expect(dataset.meta.keywords).toEqual([
      { key: 'LABEL', value: 'beamLab synthetic fixture' },
      { key: 'LABEL', value: 'LM-63-1986 variant, no header line' },
    ]);
    expect(dataset.meta.lumens).toBe(1000);
  });

  it('joins [MORE] lines onto the previous keyword', () => {
    const { dataset } = parseIes(fixture('format-lm63-1995.ies'));
    expect(dataset.meta.keywords).toContainEqual({ key: 'LUMCAT', value: 'V-1995\ncontinued catalogue text' });
  });

  it('reads 2019 keywords and treats lumens -1 as absolute photometry', () => {
    const { dataset } = parseIes(fixture('format-lm63-2019.ies'));
    expect(dataset.meta.keywords).toContainEqual({ key: 'ISSUEDATE', value: '2026-11-14' });
    expect(dataset.meta.keywords).toContainEqual({ key: 'OTHER', value: 'first line\nsecond line' });
    expect(dataset.meta.lumens).toBeNull();
    expect(dataset.meta.dimensions).toEqual({ width: 0.2, length: 0.3, height: 0.1, units: 'meters' });
    expect(dataset.meta.watts).toBe(55);
  });

  it('warns on an unknown header version and reads it as LM-63-2002', () => {
    const text = fixture('format-lm63-2002.ies').replace('IESNA:LM-63-2002', 'IESNA:LM-63-2010');
    const { dataset, warnings } = parseIes(text);
    expect(codes(warnings)).toContain('UNKNOWN_FORMAT_VERSION');
    expect(dataset.meta.sourceFormat).toBe('LM-63-2002');
    expectVariantValues(dataset);
  });

  it('warns on a non-keyword line in a keyword-based format', () => {
    const text = fixture('format-lm63-2002.ies').replace('[TESTLAB] beamLab', 'stray text');
    const { dataset, warnings } = parseIes(text);
    expect(codes(warnings)).toContain('NON_KEYWORD_LINE');
    expect(dataset.meta.keywords).toContainEqual({ key: 'LABEL', value: 'stray text' });
  });
});

describe('TILT', () => {
  it('parses and skips a TILT=INCLUDE block, with a warning', () => {
    const { dataset, warnings } = parseIes(fixture('format-tilt-include.ies'));
    expect(codes(warnings)).toContain('TILT_INCLUDE_IGNORED');
    expectVariantValues(dataset);
  });

  it('warns that a TILT=<file> reference is not loaded', () => {
    const { dataset, warnings } = parseIes(fixture('format-tilt-file.ies'));
    expect(codes(warnings)).toContain('TILT_FILE_NOT_LOADED');
    expectVariantValues(dataset);
  });

  it('throws when there is no TILT line', () => {
    expectThrowCode(fixture('format-lm63-2002.ies').replace('TILT=NONE', ''), 'NO_TILT_LINE');
  });
});

describe('candela factors', () => {
  it('applies candela multiplier × ballast factor × ballast-lamp photometric factor', () => {
    const { dataset, warnings } = parseIes(fixture('format-multiplier-ballast.ies'));
    expectVariantValues(dataset, 1e-6);
    expect(dataset.meta.multiplier).toBe(MULTIPLIER_CASE.multiplier);
    expect(dataset.meta.ballastFactor).toBe(MULTIPLIER_CASE.ballast);
    expect(dataset.meta.ballastLampFactor).toBe(MULTIPLIER_CASE.blpf);
    expect(codes(warnings)).not.toContain('FUTURE_USE_FACTOR_APPLIED');
  });

  it('applies a non-1 "future use" factor in LM-63-1995+ files, with a warning', () => {
    const { dataset, warnings } = parseIes(fixture('format-future-use-factor.ies'));
    expect(codes(warnings)).toContain('FUTURE_USE_FACTOR_APPLIED');
    expect(dataset.meta.ballastLampFactor).toBe(FUTURE_USE_FACTOR);
    expectVariantValues(dataset, 1e-6);
  });
});

describe('angular ranges and symmetry', () => {
  it('accepts a range smaller than standard, with coverage set to the real range', () => {
    const { dataset, warnings } = parseIes(fixture('uniform-limited-typeA.ies'));
    expect(codes(warnings)).toEqual(['RANGE_SMALLER_THAN_STANDARD']);
    expect(dataset.coverage).toEqual({
      hMin: UNIFORM_LIMITED.hMin,
      hMax: UNIFORM_LIMITED.hMax,
      vMin: UNIFORM_LIMITED.vMin,
      vMax: UNIFORM_LIMITED.vMax,
    });
    expect(sample(dataset, 46, 0)).toBeNaN();
    expect(sample(dataset, 0, -16)).toBeNaN();
  });

  it('expands a Type A file with H 0..90 to H -90..90 by mirroring', () => {
    const { dataset, warnings } = parseIes(fixture('symmetric-half-typeA.ies'));
    expect(codes(warnings)).toContain('SYMMETRY_EXPANDED');
    expect(dataset.grid.h).toEqual(range(-90, 90, 10));
    expect(dataset.coverage.hMin).toBe(-90);
    for (const h of [10, 30, 90]) {
      for (const v of [-60, 0, 40]) {
        expect(sample(dataset, -h, v)).toBe(sample(dataset, h, v));
        expect(sample(dataset, -h, v)).toBe(halfSymmetricCd(h, v));
      }
    }
    expect(dataset.provenance?.params['symmetry']).toBe('lateral (H 0..90 mirrored)');
  });

  describe('Type C symmetry expansion', () => {
    const gammas = range(0, 180, 5);
    const cases: Array<{ name: string; h: number[]; f: (c: number, g: number) => number }> = [
      { name: 'rotational (single plane C=0)', h: [0], f: (_c, g) => 1000 + 3 * g },
      {
        name: 'quadrant (C 0..90)',
        h: range(0, 90, 5),
        f: (c, g) => 1000 + 500 * Math.cos((2 * c * Math.PI) / 180) * Math.sin((g * Math.PI) / 180),
      },
      {
        name: 'bilateral (C 0..180)',
        h: range(0, 180, 5),
        f: (c, g) => 1000 + 500 * Math.cos((c * Math.PI) / 180) * Math.sin((g * Math.PI) / 180),
      },
      {
        name: 'bilateral (C 90..270)',
        h: range(90, 270, 5),
        f: (c, g) => 1000 + 500 * Math.sin((c * Math.PI) / 180) * Math.sin((g * Math.PI) / 180),
      },
    ];
    it.each(cases)('$name is expanded to the full sphere', ({ h, f }) => {
      const text = writeIes({ header: 'IESNA:LM-63-2002', keywordLines: [], type: 1, h, v: gammas, cd: f, decimals: 6 });
      const { dataset, warnings } = parseIes(text);
      expect(codes(warnings)).toContain('SYMMETRY_EXPANDED');
      for (const c of [20, 75, 135, 200, 250, 310, 345]) {
        for (const g of [40, 90, 130]) {
          const a = vectorToAngles('A', dirTypeC(c, g));
          expect(Math.abs(sample(dataset, a.h, a.v) - f(c, g)), `C=${c} γ=${g}`).toBeLessThan(15);
        }
      }
    });
  });
});

describe('sign convention (FRAMEWORK.md section 10)', () => {
  it('puts the asymmetric hot spot right (+H) and up (+V)', () => {
    const { dataset } = parseIes(fixture('asymmetric-typeA.ies'));
    expect(sample(dataset, 20, 6)).toBeCloseTo(asymmetricCd(20, 6), 2);
    expect(sample(dataset, 20, 6)).toBeGreaterThan(4500);
    expect(sample(dataset, -20, 6)).toBeLessThan(500); // mirror left: dark
    expect(sample(dataset, 20, -6)).toBeLessThan(500); // mirror down: dark
    expect(sample(dataset, -16, -10)).toBeCloseTo(asymmetricCd(-16, -10), 2); // weak spot left-down
  });

  it('flipH mirrors left/right and records it in provenance', () => {
    const { dataset } = parseIes(fixture('asymmetric-typeA.ies'), { flipH: true });
    expect(sample(dataset, -20, 6)).toBeCloseTo(asymmetricCd(20, 6), 2);
    expect(sample(dataset, 20, 6)).toBeLessThan(500);
    expect(sample(dataset, 16, -10)).toBeCloseTo(asymmetricCd(-16, -10), 2);
    expect(dataset.grid.h[0]).toBe(-40);
    expect(dataset.provenance?.params['flipH']).toBe(true);
  });
});

describe('malformed files', () => {
  it('fills missing candela with NaN when tokens are short', () => {
    const { dataset, warnings } = parseIes(fixture('malformed-token-short.ies'));
    expect(codes(warnings)).toContain('TOKEN_COUNT_MISMATCH');
    // Last 4 tokens dropped: the whole H=10 plane and (H=5, V=5)
    for (const v of VARIANT_V) expect(sample(dataset, 10, v)).toBeNaN();
    expect(sample(dataset, 5, 5)).toBeNaN();
    expect(sample(dataset, 5, 0)).toBe(variantCd(5, 0));
  });

  it('ignores extra tokens with a warning', () => {
    const { dataset, warnings } = parseIes(fixture('malformed-token-long.ies'));
    expect(codes(warnings)).toContain('TOKEN_COUNT_MISMATCH');
    expectVariantValues(dataset);
  });

  it('sorts non-ascending angles with a warning, keeping each value with its angle', () => {
    const { dataset, warnings } = parseIes(fixture('malformed-non-ascending.ies'));
    expect(codes(warnings)).toContain('ANGLES_NOT_ASCENDING');
    expectVariantValues(dataset);
  });

  it('keeps negative candela but warns', () => {
    const { dataset, warnings } = parseIes(fixture('malformed-negative-candela.ies'));
    expect(codes(warnings)).toContain('NEGATIVE_CANDELA');
    expect(sample(dataset, 5, 0)).toBe(-50);
  });

  it('drops duplicate angles with a warning', () => {
    const text = writeIes({
      header: 'IESNA:LM-63-2002',
      keywordLines: [],
      type: 3,
      h: [-10, 0, 0, 10],
      v: [0, 5],
      cd: (h) => 100 + h,
    });
    const { dataset, warnings } = parseIes(text);
    expect(codes(warnings)).toContain('DUPLICATE_ANGLE');
    expect(dataset.grid.h).toEqual([-10, 0, 10]);
  });

  it.each([
    ['empty file', '', 'NO_TILT_LINE'],
    ['truncated header', 'IESNA:LM-63-2002\nTILT=NONE\n1 -1 1 3 5 3', 'UNEXPECTED_END'],
    ['bad photometric type', 'IESNA:LM-63-2002\nTILT=NONE\n1 -1 1 1 1 4 2 0 0 0\n1 1 0\n0\n0\n5', 'BAD_PHOTOMETRIC_TYPE'],
    ['non-numeric header', 'IESNA:LM-63-2002\nTILT=NONE\n1 -1 x 1 1 3 2 0 0 0\n1 1 0\n0\n0\n5', 'NON_NUMERIC_HEADER'],
    ['bad angle count', 'IESNA:LM-63-2002\nTILT=NONE\n1 -1 1 0 1 3 2 0 0 0\n1 1 0\n0\n5', 'BAD_ANGLE_COUNT'],
    ['missing angles', 'IESNA:LM-63-2002\nTILT=NONE\n1 -1 1 3 5 3 2 0 0 0\n1 1 0\n-5 0 5\n-10', 'UNEXPECTED_END'],
    ['truncated TILT block', 'IESNA:LM-63-2002\nTILT=INCLUDE\n1\n3\n0 45', 'UNEXPECTED_END'],
  ])('throws on unreadable input: %s', (_name, text, code) => {
    expectThrowCode(text, code);
  });
});

describe('non-Type-A files', () => {
  it.each([
    ['same-beam-typeB.ies', 'B'],
    ['same-beam-typeC.ies', 'C'],
  ])('%s warns about the axis assumption and records the conversion', (file, type) => {
    const { dataset, warnings } = parseIes(fixture(file));
    expect(codes(warnings)).toContain('NON_TYPE_A_AXIS_ASSUMPTION');
    expect(codes(warnings)).toContain('RESAMPLED_TO_TYPE_A');
    expect(dataset.meta.sourceType).toBe(type);
    const conversion = dataset.provenance?.params['conversion'] as Record<string, unknown>;
    expect(conversion['from']).toBe(type);
    expect(conversion['targetStep']).toBe(3);
    expect(conversion['interpolation']).toBe('bilinear');
    expect(conversion['axisAssumptions']).toBeDefined();
  });
});

describe('Type B file with a fine cut-off step (layout of a real automotive file)', () => {
  // H -90..90 at 2°, V -40..40 with 0.1° between -10 and 5 (as in the beamsynth Class B file)
  const h = range(-90, 90, 2);
  const v = [...range(-40, -11, 1), ...range(-10, 5, 0.1), ...range(6, 40, 1)];
  const cd = (hh: number, vv: number) => (hh === 2 && vv === -0.6 ? 36181.4 : 1000 + 10 * Math.abs(vv));
  const text = writeIes({ header: 'IESNA:LM-63-2002', keywordLines: [], type: 2, h, v, cd, decimals: 1 });

  it('is converted at the file’s own 0.1° step, without coarsening', () => {
    const { dataset, warnings } = parseIes(text);
    expect(codes(warnings)).not.toContain('RESAMPLE_STEP_COARSENED');
    const conversion = dataset.provenance?.params['conversion'] as Record<string, unknown>;
    expect(conversion['targetStep']).toBe(0.1);
    expect(dataset.coverage.vMin).toBeGreaterThanOrEqual(-40 - 1e-9);
    expect(dataset.coverage.vMax).toBeLessThanOrEqual(40 + 1e-9);
  });

  it('keeps the peak node value within 0.5% (the coarsened conversion lost ~5%)', () => {
    const { dataset } = parseIes(text);
    // Small residual: Type A (2, -0.6) is not exactly Type B (2, -0.6), and this spike is very sharp.
    expect(Math.abs(sample(dataset, 2, -0.6) / 36181.4 - 1)).toBeLessThan(0.005);
  });
});

describe('dataset identity', () => {
  it('uses a deterministic id from the content and the given name', () => {
    const text = fixture('format-lm63-2002.ies');
    const a = parseIes(text, { name: 'lamp.ies' }).dataset;
    const b = parseIes(text).dataset;
    expect(a.id).toBe(b.id);
    expect(a.name).toBe('lamp.ies');
    expect(parseIes(text, { flipH: true }).dataset.id).not.toBe(a.id);
  });

  it('every warning has a code, message and severity', () => {
    const { warnings } = parseIes(fixture('malformed-token-short.ies'));
    for (const w of warnings) {
      expect(w.code).toMatch(/^[A-Z_]+$/);
      expect(w.message.length).toBeGreaterThan(0);
      expect(['info', 'warning']).toContain(w.severity);
    }
  });
});
