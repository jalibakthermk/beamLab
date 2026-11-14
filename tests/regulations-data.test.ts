import { describe, expect, it } from 'vitest';
import { parseRegulation, type Regulation } from '../core/regs/schema';
import { evaluateRegulation } from '../core/regs/engine';
import { parseIes } from '../core/io/ies';
import { fixture } from './load-fixture';

const files = import.meta.glob<unknown>('../data/regulations/*.json', { import: 'default', eager: true });
const regs: Array<[string, Regulation]> = Object.entries(files).map(([f, obj]) => [f.replace('../data/regulations/', ''), parseRegulation(obj)]);
const byId = new Map(regs.map(([, r]) => [r.id, r]));
const el = (id: string, name: string) => byId.get(id)!.elements.find((e) => e.name === name)!;

describe('data/regulations (migrated from import/: UN R148 Rev.0 Amend.5, UN R149 Rev.0 Amend.6)', () => {
  it('every file is a valid regulation whose id matches its file name', () => {
    expect(regs.length).toBe(29);
    for (const [file, r] of regs) expect(`${r.id}.json`).toBe(file);
  });

  it('every file is unverified, names its source and revision, and every element has a source reference', () => {
    for (const [, r] of regs) {
      expect(r.verified).toBe(false);
      expect(r.source).toMatch(/UN Regulation No\. 14[89]/);
      expect(r.revision).toMatch(/Amendment [56]/);
      for (const e of r.elements) expect(e.ref, `${r.id} / ${e.name}`).toBeTruthy();
    }
  });

  it('spot checks against the source tables', () => {
    expect(el('UNR149-R0A6-classC-passing-beam', '75 R')).toMatchObject({ h: 1.15, v: -0.57, min: 12100 });
    expect(el('UNR149-R0A6-classC-passing-beam', '50 L')).toMatchObject({ h: -3.43, v: -0.86, min: 5000, max: 37000 });
    expect(el('UNR149-R0A6-classV-passing-beam', 'Imax')).toMatchObject({ type: 'global', max: 44100 });
    expect(byId.get('UNR149-R0A6-classC-passing-beam')!.aim).toEqual({ modes: ['as-loaded', 'aim-to-cutoff', 're-aim-search'], nominalCutoffV: -0.57, reaim: { h: 0.75, v: 0.25 } });
    expect(el('UNR148-R0A5-stop-S1', 'HV')).toMatchObject({ min: 60 });
    expect(el('UNR148-R0A5-stop-S1', '5U-V')).toMatchObject({ h: 0, v: 5, min: { percent: 70, of: { parameter: 'Imin' } } });
    expect(el('UNR148-R0A5-reversing-AR', '5D-V')).toMatchObject({ min: 80 });
  });

  it('min ≤ max everywhere, except the three categories flagged as a likely misprint in R148 Table 8', () => {
    const inconsistent = regs
      .filter(([, r]) => {
        const hv = r.elements.find((e) => e.name === 'HV');
        const g = r.elements.find((e) => e.type === 'global');
        return typeof hv?.min === 'number' && typeof g?.max === 'number' && hv.min > g.max;
      })
      .map(([, r]) => r.id)
      .sort();
    expect(inconsistent).toEqual(['UNR148-R0A5-direction-indicator-11a', 'UNR148-R0A5-direction-indicator-11b', 'UNR148-R0A5-direction-indicator-11c']);
  });

  it('the engine evaluates every file without errors', () => {
    const ds = parseIes(fixture('cutoff-plain-fine.ies')).dataset;
    for (const [, r] of regs) {
      const res = evaluateRegulation(ds, r);
      expect(res.elements.length).toBe(r.elements.length);
    }
  });
});
