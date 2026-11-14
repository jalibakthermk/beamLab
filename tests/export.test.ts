import { describe, expect, it } from 'vitest';
import { exportIes, ExportError } from '../core/io/export';
import { exportCsv } from '../core/io/csv';
import { parseIes } from '../core/io/ies';
import type { PhotometricDataset } from '../core/model/dataset';
import { fixture } from './load-fixture';

const T = '2026-11-14T00:00:00.000Z';
const numericBlock = (ies: string) => ies.slice(ies.indexOf('TILT=NONE'));

function expectCodeThrown(fn: () => unknown, code: string) {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ExportError);
    expect((e as ExportError).code).toBe(code);
    return;
  }
  throw new Error(`expected ExportError ${code}`);
}

describe('IES export (LM-63-2002, Type A)', () => {
  it.each([
    'format-lm63-1986.ies',
    'format-lm63-2019.ies',
    'format-multiplier-ballast.ies',
    'gaussian-spot-typeA.ies',
    'asymmetric-typeA.ies',
    'symmetric-half-typeA.ies',
    'uniform-sphere-typeC.ies',
  ])('%s: load → export → load keeps the grid and values to the written precision', (file) => {
    const first = parseIes(fixture(file), { timestamp: T }).dataset;
    const text = exportIes(first);
    const second = parseIes(text, { timestamp: T }).dataset;

    expect(second.grid).toEqual(first.grid);
    expect(second.coverage).toEqual(first.coverage);
    for (let i = 0; i < first.values.length; i++) {
      const a = first.values[i]!;
      const b = second.values[i]!;
      expect(Math.abs(b - a)).toBeLessThanOrEqual(Math.abs(a) * 5e-7 + 1e-12);
    }
    // Writing what was read back gives the identical numeric block: lossless at that precision
    expect(numericBlock(exportIes(second))).toBe(numericBlock(text));
    expect(second.meta.sourceFormat).toBe('LM-63-2002');
    expect(second.meta.sourceType).toBe('A');
  });

  it('writes header, TILT=NONE, multiplier 1, Type 3, and lines under 132 characters', () => {
    const ds = parseIes(fixture('gaussian-spot-typeA.ies')).dataset;
    const text = exportIes(ds);
    const lines = text.split('\r\n');
    expect(lines[0]).toBe('IESNA:LM-63-2002');
    expect(lines).toContain('TILT=NONE');
    const header = lines[lines.indexOf('TILT=NONE') + 1]!.split(' ');
    expect(header[2]).toBe('1'); // candela multiplier
    expect(header[5]).toBe('3'); // photometric type A
    for (const l of lines) expect(l.length).toBeLessThan(132);
  });

  it('keeps source keywords and adds provenance as keyword lines', () => {
    const ds = parseIes(fixture('format-lm63-2019.ies'), { timestamp: T }).dataset;
    const re = parseIes(exportIes(ds)).dataset;
    const keys = re.meta.keywords;
    for (const k of ds.meta.keywords) expect(keys).toContainEqual(k);
    const prov = keys.find((k) => k.key === '_PROVENANCE');
    expect(prov).toBeDefined();
    expect(JSON.parse(prov!.value.replace(/\n/g, ''))).toEqual(ds.provenance);
  });

  it('turns LM-63-1986 labels into [OTHER] and adds required [TEST] / [MANUFAC]', () => {
    const ds = parseIes(fixture('format-lm63-1986.ies')).dataset;
    const text = exportIes(ds);
    expect(text).toContain('[OTHER] beamLab synthetic fixture');
    expect(text).toMatch(/\[TEST\] /);
    expect(text).toMatch(/\[MANUFAC\] /);
  });

  it('splits long keyword values over [MORE] lines', () => {
    const ds = parseIes(fixture('format-lm63-2002.ies')).dataset;
    const long = 'x'.repeat(300);
    const withLong: PhotometricDataset = {
      ...ds,
      meta: { ...ds.meta, keywords: [...ds.meta.keywords, { key: 'OTHER', value: long }] },
    };
    const text = exportIes(withLong);
    for (const l of text.split('\r\n')) expect(l.length).toBeLessThan(132);
    const back = parseIes(text).dataset.meta.keywords.find((k) => k.key === 'OTHER');
    expect(back?.value.replace(/\n/g, '')).toBe(long);
  });

  it("refuses datasets whose kind is not 'intensity'", () => {
    const ds = parseIes(fixture('format-lm63-2002.ies')).dataset;
    expectCodeThrown(() => exportIes({ ...ds, kind: 'ratio' }), 'NOT_INTENSITY');
  });

  it('refuses datasets containing NaN', () => {
    const ds = parseIes(fixture('malformed-token-short.ies')).dataset;
    expectCodeThrown(() => exportIes(ds), 'CONTAINS_NAN');
  });
});

describe('CSV matrix export', () => {
  it('has H as columns and V as rows, NaN as empty cells', () => {
    const ds = parseIes(fixture('malformed-token-short.ies')).dataset;
    const rows = exportCsv(ds).trim().split('\n');
    expect(rows[0]).toBe('V\\H,-10,-5,0,5,10');
    expect(rows).toHaveLength(4);
    expect(rows[1]).toBe('-5,910,947.5,985,1022.5,');
    expect(rows[3]).toBe('5,890,952.5,1015,,');
  });
});
