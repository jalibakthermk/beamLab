import { describe, expect, it } from 'vitest';
import { add, clampToIntensity, divide, scale, subtract } from '../core/ops/arithmetic';
import { provenanceChain } from '../core/model/provenance';
import { parseIes } from '../core/io/ies';
import { exportIes } from '../core/io/export';
import { fixture } from './load-fixture';

const T = '2026-11-14T12:00:00.000Z';
const lo = parseIes(fixture('format-lm63-2002.ies'), { name: 'low.ies' }).dataset;
const hi = parseIes(fixture('format-lm63-1995.ies'), { name: 'high.ies', flipH: true }).dataset;
const c = parseIes(fixture('same-beam-typeC.ies'), { name: 'typeC.ies' }).dataset;

describe('provenance of operation results', () => {
  it('records operation, input ids and names, all parameters, resampling and a timestamp', () => {
    const r = add(lo, c, { weights: [1, 0.5], extent: 'union', zeroOutside: { a: false, b: true }, timestamp: T });
    const p = r.provenance!;
    expect(p.op).toBe('add');
    expect(p.inputs).toEqual([lo.id, c.id]);
    expect(p.params['inputNames']).toEqual(['low.ies', 'typeC.ies']);
    expect(p.params['weights']).toEqual([1, 0.5]);
    expect(p.params['extent']).toBe('union');
    expect(p.params['zeroOutside']).toEqual({ a: false, b: true });
    expect(p.params['resampled']).toBe(true);
    expect(p.params['grid']).toEqual({ h: r.grid.h.length, v: r.grid.v.length });
    expect(p.timestamp).toBe(T);
    expect(p.parents?.map((x) => x.name)).toEqual(['low.ies', 'typeC.ies']);
  });

  it('gives each result a deterministic id and a readable default name', () => {
    expect(add(lo, hi, { timestamp: T }).id).toBe(add(lo, hi, { timestamp: T }).id);
    expect(add(lo, hi).id).not.toBe(subtract(lo, hi).id);
    expect(add(lo, hi).name).toBe('low.ies + high.ies');
    expect(subtract(lo, hi).name).toBe('low.ies - high.ies');
    expect(scale(lo, 0.9).name).toBe('low.ies x 0.9');
    expect(divide(lo, hi).name).toBe('low.ies / high.ies');
    expect(add(lo, hi, { name: 'Combined' }).name).toBe('Combined');
  });
});

describe('provenanceChain', () => {
  const sum = add(lo, hi, { timestamp: T });
  const diff = subtract(sum, c, { timestamp: T });
  const clamped = clampToIntensity(diff, { name: 'final', timestamp: T });
  const text = provenanceChain(clamped);

  it('walks back to the source files, one indented line per step', () => {
    const lines = text.split('\n');
    expect(lines[0]).toMatch(/^final \[intensity\] = clamp negatives to zero/);
    expect(lines.some((l) => /^ {2}- .*\[difference\] = subtract/.test(l))).toBe(true);
    expect(lines.some((l) => /^ {4}- .*\[intensity\] = add: 1 x low\.ies \+ 1 x high\.ies/.test(l))).toBe(true);
    expect(lines.some((l) => /^ {6}- low\.ies \[intensity\] = import of LM-63-2002 file, Type A/.test(l))).toBe(true);
    expect(lines.some((l) => /^ {6}- high\.ies .*mirrored left\/right \(flipH\)/.test(l))).toBe(true);
    expect(lines.some((l) => /typeC\.ies .*Type C converted to Type A at 3 deg steps/.test(l))).toBe(true);
  });

  it('mentions resampling and the coverage policy', () => {
    expect(text).toMatch(/resampled onto a merged grid of \d+ x \d+/);
    expect(text).toMatch(/identical grids, node by node/);
    expect(text).toMatch(/outside coverage: A NaN, B NaN/);
  });

  it('a source file on its own gives one line', () => {
    expect(provenanceChain(lo).split('\n')).toHaveLength(1);
  });
});

describe('IES export writes the chain into keyword lines', () => {
  it('as [_PROVENANCE_CHAIN] keyword with [MORE] lines, readable after re-import', () => {
    const r = add(lo, scale(hi, 0.5), { timestamp: T });
    const ies = exportIes(r);
    for (const l of ies.split('\r\n')) expect(l.length).toBeLessThan(132);
    const back = parseIes(ies).dataset.meta.keywords.find((k) => k.key === '_PROVENANCE_CHAIN');
    // Lines longer than the IES limit are split over extra [MORE] lines, so compare without line breaks
    expect(back?.value.replace(/\n/g, '')).toBe(provenanceChain(r).replace(/\n/g, ''));
    expect(back!.value.split('\n').length).toBeGreaterThanOrEqual(provenanceChain(r).split('\n').length);
    expect(ies).toMatch(/^\[_PROVENANCE_CHAIN\] /m);
  });
});
