import { describe, expect, it } from 'vitest';
import { createStore, type LoadedFile } from '../ui/state/store';
import { settingsFromState } from '../ui/state/settings';
import { matchFiles, mergeKnown, parseSettings, resolveRefs, SettingsError } from '../core/settings';
import { fixture } from './load-fixture';

// SHA-256 with Web Crypto, as in the browser
const hex = async (t: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t)))].map((b) => b.toString(16).padStart(2, '0')).join('');
const NAMES = ['road-beam-typeA.ies', 'gaussian-spot-typeA.ies'];
const HASH = new Map(await Promise.all(NAMES.map(async (n) => [fixture(n), await hex(fixture(n))] as const)));
const sha = (t: string) => HASH.get(t)!;
const file = (name: string): LoadedFile => ({ name, text: fixture(name), sha256: sha(fixture(name)) });

function configured() {
  const store = createStore();
  store.addFiles([file('road-beam-typeA.ies'), file('gaussian-spot-typeA.ies')]);
  const [a, b] = store.getState().entries;
  store.select(b!.key);
  store.setView({ mode: 'heatmap', scale: 'log' });
  store.setEvaluate({ regId: 'data:UNR149-R0A6-classC-passing-beam', traffic: 'RHT', scaleFactor: 0.9 });
  store.setCutoff({ scanH: -2.5 });
  store.setRoad({
    lamps: [{ entryKey: a!.key, mirror: false, x: 0, y: -0.7, height: 0.65, yaw: 0, pitch: -0.57, roll: 0 }, { entryKey: b!.key, mirror: true, x: 0, y: 0.7, height: 0.65, yaw: 0, pitch: -0.57, roll: 0 }],
    pair: { ...store.getState().road.pair, leftKey: a!.key },
    levelsText: '1, 3',
  });
  store.setReport({ title: 'Lamp X', author: 'A. Tester' });
  return store;
}

describe('settings file', () => {
  it('holds names and hashes of the files, never their content', () => {
    const sf = settingsFromState(configured().getState(), '1.0.0', '2026-11-14T12:00:00Z');
    const json = JSON.stringify(sf);
    expect(sf.files).toEqual([
      { ref: 'f1', name: 'road-beam-typeA.ies', sha256: sha(fixture('road-beam-typeA.ies')), flipH: false },
      { ref: 'f2', name: 'gaussian-spot-typeA.ies', sha256: sha(fixture('gaussian-spot-typeA.ies')), flipH: false },
    ]);
    expect(json).not.toContain('TILT');
    expect(json).not.toContain('IESNA');
    expect(json.length).toBeLessThan(5000);
    expect((sf.sections['road'] as { lamps: Array<{ entryKey: string }> }).lamps.map((l) => l.entryKey)).toEqual(['@file:f1', '@file:f2']);
    expect(parseSettings(JSON.parse(json))).toBeTruthy();
  });

  it('round trip: settings apply at once, file references once the same files are loaded again', () => {
    const sf = parseSettings(JSON.parse(JSON.stringify(settingsFromState(configured().getState(), '1.0.0', 'now'))));
    const fresh = createStore();
    fresh.importSettings(sf);
    let s = fresh.getState();
    expect(s.view).toMatchObject({ mode: 'heatmap', scale: 'log' });
    expect(s.evaluate).toMatchObject({ regId: 'data:UNR149-R0A6-classC-passing-beam', scaleFactor: 0.9 });
    expect(s.cutoff.scanH).toBe(-2.5);
    expect(s.report).toMatchObject({ title: 'Lamp X', author: 'A. Tester' });
    expect(s.road.lamps.map((l) => l.entryKey)).toEqual([null, null]);
    expect(s.settingsImport!.matches.map((m) => m.status)).toEqual(['missing', 'missing']);

    // Load one file, then the other; matched by hash
    fresh.addFiles([file('gaussian-spot-typeA.ies')]);
    s = fresh.getState();
    expect(s.settingsImport!.matches.map((m) => m.status)).toEqual(['missing', 'matched']);
    expect(s.road.lamps[1]!.entryKey).toBe(s.entries[0]!.key);
    fresh.addFiles([file('road-beam-typeA.ies')]);
    s = fresh.getState();
    expect(s.settingsImport!.matches.map((m) => m.status)).toEqual(['matched', 'matched']);
    expect(s.road.lamps.map((l) => l.entryKey)).toEqual([s.entries[1]!.key, s.entries[0]!.key]);
    expect(s.road.pair.leftKey).toBe(s.entries[1]!.key);
    expect(s.road.levelsText).toBe('1, 3');
    expect(s.selectedKey).toBe(s.entries[0]!.key);

    // Later edits are kept
    fresh.setRoad({ levelsText: '5' });
    expect(fresh.getState().road.levelsText).toBe('5');
  });

  it('a file with the same name but different content is a hash mismatch and is not used', () => {
    const sf = parseSettings(JSON.parse(JSON.stringify(settingsFromState(configured().getState(), '1.0.0', 'now'))));
    const fresh = createStore();
    fresh.importSettings(sf);
    fresh.addFiles([{ name: 'road-beam-typeA.ies', text: fixture('gaussian-spot-typeA.ies'), sha256: sha(fixture('gaussian-spot-typeA.ies')) + '' }]);
    const m = fresh.getState().settingsImport!.matches;
    // that content matches f2 (by hash), so f1 is reported as a mismatch by name
    expect(m.map((x) => x.status)).toEqual(['hash-mismatch', 'matched']);
  });

  it('validation lists problems and rejects file content or unknown references', () => {
    try {
      parseSettings({ format: 'beamLab-settings', version: 1, appVersion: '1', saved: 'x', files: [{ ref: 'f1', name: 'a.ies', sha256: 'xyz', flipH: false, text: 'TILT=NONE' }], sections: { road: { lamps: [{ entryKey: '@file:f9' }] } } });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(SettingsError);
      const p = (e as SettingsError).problems;
      expect(p).toContain('files[0].sha256: must be 64 hex characters');
      expect(p).toContain('files[0]: unexpected field(s) text (settings never hold file content)');
      expect(p).toContain('sections.road.lamps[0].entryKey: refers to unknown file "f9"');
    }
    expect(() => parseSettings({ format: 'other' })).toThrow(SettingsError);
  });

  it('mergeKnown keeps only known keys of the right type; resolveRefs and matchFiles', () => {
    expect(mergeKnown({ a: 1, b: 'x', c: null as number | null, d: { e: true } }, { a: 'no', b: 'y', c: 3, d: { e: false, f: 1 }, z: 9 })).toEqual({ a: 1, b: 'y', c: 3, d: { e: false } });
    const h = 'a'.repeat(64);
    const m = matchFiles([{ ref: 'f1', name: 'x.ies', sha256: h, flipH: false }], [{ key: 'k1', name: 'renamed.ies', sha256: h, flipH: false }]);
    expect(m[0]).toMatchObject({ status: 'matched', key: 'k1' });
    expect(resolveRefs({ a: ['@file:f1', '@file:f2', 'plain'] }, m)).toEqual({ a: ['k1', null, 'plain'] });
  });
});
