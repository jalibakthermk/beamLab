import { describe, expect, it } from 'vitest';
import { parseRegulation, RegulationError } from '../core/regs/schema';
import TEST from './fixtures/regs/TEST-invented-values.json';

const clone = () => JSON.parse(JSON.stringify(TEST)) as Record<string, unknown> & { elements: Array<Record<string, unknown>> };

function messages(obj: unknown): string[] {
  try {
    parseRegulation(obj);
  } catch (e) {
    expect(e).toBeInstanceOf(RegulationError);
    return (e as RegulationError).problems;
  }
  throw new Error('expected RegulationError');
}

describe('regulation schema and validator', () => {
  it('accepts the TEST file and keeps every value', () => {
    const r = parseRegulation(TEST);
    expect(r.id).toBe('TEST-invented-values');
    expect(r.verified).toBe(false);
    expect(r.units).toBe('cd');
    expect(r.elements).toHaveLength(11);
    expect(r.elements[1]).toMatchObject({ type: 'point', name: 'Q', min: { percent: 80, of: { parameter: 'Iref' } } });
    expect(r.aim).toEqual({ modes: ['as-loaded', 'aim-to-cutoff', 're-aim-search'], nominalCutoffV: null, reaim: { h: null, v: null } });
  });

  it('verified defaults to false when missing', () => {
    const o = clone();
    delete o['verified'];
    expect(parseRegulation(o).verified).toBe(false);
  });

  it('rejects malformed files, naming the field path', () => {
    expect(messages({})).toEqual(expect.arrayContaining([expect.stringMatching(/^id:/), expect.stringMatching(/^elements:/)]));
    const o = clone();
    o['units'] = 'lux';
    o.elements[0]!['h'] = '2.5';
    o.elements[1]!['name'] = 'P';
    o.elements[5]!['from'] = [1];
    o.elements[6]!['polygon'] = [[0, 0], [1, 1]];
    o.elements[8]!['b'] = 'nope';
    o.elements[3]!['min'] = { percent: 90, of: { element: 'missing' } };
    o.elements[4]!['min'] = { percent: '50', of: 'max' };
    o.elements[2]!['type'] = 'circle';
    o['aim'] = { modes: ['fly'], nominalCutoffV: 'x', reaim: { h: null } };
    const m = messages(o);
    expect(m).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^units: must be "cd" or "lx@25m"/),
        expect.stringMatching(/^elements\[0\] \(P\)\.h: must be a number or null/),
        expect.stringMatching(/duplicate element name "P"/),
        expect.stringMatching(/^elements\[5\] \(L\)\.from: must be \[H, V\]/),
        expect.stringMatching(/^elements\[6\] \(Zmax\)\.polygon: needs at least 3 vertices/),
        expect.stringMatching(/^elements\[8\] \(P\/Q\)\.b: refers to unknown element "nope"/),
        expect.stringMatching(/^elements\[3\] \(P90\)\.min: percent of unknown element "missing"/),
        expect.stringMatching(/^elements\[4\] \(Pmax\)\.min\.percent: must be a number or null/),
        expect.stringMatching(/^elements\[2\] \(R1\)\.type: must be one of point, line, zone, ratio, global/),
        expect.stringMatching(/^aim\.modes\[0\]: must be one of as-loaded, aim-to-cutoff, re-aim-search/),
        expect.stringMatching(/^aim\.nominalCutoffV: must be a number or null/),
        expect.stringMatching(/^aim\.reaim\.v: must be a number or null/),
      ]),
    );
  });

  it('rejects unknown parameters and circular percentage references', () => {
    const o = clone();
    o.elements[1]!['min'] = { percent: 80, of: { parameter: 'Nope' } };
    o.elements[3]!['min'] = { percent: 90, of: { element: 'P90' } };
    const m = messages(o);
    expect(m).toEqual(expect.arrayContaining([expect.stringMatching(/unknown parameter "Nope"/), expect.stringMatching(/circular reference.*P90/)]));
  });

  it('a limit form must be a number, null, or { percent, of }', () => {
    const o = clone();
    o.elements[0]!['max'] = { value: 3 };
    expect(messages(o)).toEqual(expect.arrayContaining([expect.stringMatching(/^elements\[0\] \(P\)\.max: must be a number, null, or \{ "percent", "of" \}/)]));
  });
});
