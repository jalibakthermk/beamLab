import { describe, expect, it, vi } from 'vitest';
import { createStore } from '../ui/state/store';
import { subtract } from '../core/ops/arithmetic';
import { fixture } from './load-fixture';

const file = (name: string) => ({ name, text: fixture(name) });

describe('app state store', () => {
  it('starts empty with default view settings', () => {
    const s = createStore().getState();
    expect(s.entries).toEqual([]);
    expect(s.selectedKey).toBeNull();
    expect(s.overlayKey).toBeNull();
    expect(s.view).toEqual({ mode: 'contour', scale: 'linear', levelsMode: 'auto', customLevels: [], marker: null });
    expect(s.preview).toBeNull();
    expect(s.panelTab).toBe('info');
  });

  it('loads several files at once, keeps warnings per file, and selects the first loaded one', () => {
    const store = createStore();
    store.addFiles([file('gaussian-spot-typeA.ies'), file('format-tilt-include.ies')]);
    const { entries, selectedKey } = store.getState();
    expect(entries.map((e) => e.name)).toEqual(['gaussian-spot-typeA.ies', 'format-tilt-include.ies']);
    expect(selectedKey).toBe(entries[0]!.key);
    expect(entries[0]!.warnings.map((w) => w.code)).toEqual(['RANGE_SMALLER_THAN_STANDARD']);
    expect(entries[1]!.warnings.map((w) => w.code)).toContain('TILT_INCLUDE_IGNORED');
    expect(entries[0]!.summary?.maxIntensity).toBe(20000);
  });

  it('a file that fails to parse gets a clear error and does not affect the others', () => {
    const store = createStore();
    store.addFiles([{ name: 'broken.ies', text: 'not an IES file' }, file('asymmetric-typeA.ies')]);
    const [bad, good] = store.getState().entries;
    expect(bad!.dataset).toBeNull();
    expect(bad!.error).toMatch(/TILT/);
    expect(good!.dataset).not.toBeNull();
    expect(good!.error).toBeNull();
    expect(store.getState().selectedKey).toBe(good!.key);
    store.select(bad!.key); // cannot select a failed file
    expect(store.getState().selectedKey).toBe(good!.key);
  });

  it('records a loader error for a file without parsing it', () => {
    const store = createStore();
    store.addFiles([{ name: 'photo.jpg', text: '', error: 'Not an .ies file.' }]);
    const e = store.getState().entries[0]!;
    expect(e.error).toBe('Not an .ies file.');
    expect(e.dataset).toBeNull();
    expect(store.getState().selectedKey).toBeNull();
  });

  it('overlay must be a different, successfully loaded dataset', () => {
    const store = createStore();
    store.addFiles([file('same-beam-typeA.ies'), file('same-beam-typeB.ies')]);
    const [a, b] = store.getState().entries;
    store.setOverlay(a!.key); // a is selected: refused
    expect(store.getState().overlayKey).toBeNull();
    store.setOverlay(b!.key);
    expect(store.getState().overlayKey).toBe(b!.key);
    store.select(b!.key); // selecting the overlay dataset clears the overlay
    expect(store.getState().selectedKey).toBe(b!.key);
    expect(store.getState().overlayKey).toBeNull();
    store.setOverlay(null);
    expect(store.getState().overlayKey).toBeNull();
  });

  it('removing the selected dataset selects the next one; removing the overlay clears it', () => {
    const store = createStore();
    store.addFiles([file('format-lm63-2002.ies'), file('format-lm63-1995.ies'), file('format-lm63-1991.ies')]);
    const [a, b, c] = store.getState().entries;
    store.setOverlay(c!.key);
    store.remove(a!.key);
    expect(store.getState().selectedKey).toBe(b!.key);
    store.remove(c!.key);
    expect(store.getState().overlayKey).toBeNull();
    store.remove(b!.key);
    expect(store.getState().selectedKey).toBeNull();
    expect(store.getState().entries).toEqual([]);
  });

  it('flipH reloads the dataset mirrored from the in-memory source text', () => {
    const store = createStore();
    store.addFiles([file('asymmetric-typeA.ies')]);
    const key = store.getState().entries[0]!.key;
    expect(store.getState().entries[0]!.summary?.maxAt?.h).toBe(20);
    store.setFlipH(key, true);
    const e = store.getState().entries[0]!;
    expect(e.flipH).toBe(true);
    expect(e.summary?.maxAt?.h).toBe(-20);
    expect(e.dataset?.provenance?.params['flipH']).toBe(true);
    expect(store.getState().selectedKey).toBe(key);
  });

  it('updates view settings and the cross-section marker, notifying subscribers', () => {
    const store = createStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.setView({ mode: 'heatmap', scale: 'log' });
    store.setView({ levelsMode: 'custom', customLevels: [100, 1000] });
    store.setMarker({ h: 1.5, v: -0.5 });
    const { view } = store.getState();
    expect(view).toEqual({ mode: 'heatmap', scale: 'log', levelsMode: 'custom', customLevels: [100, 1000], marker: { h: 1.5, v: -0.5 } });
    expect(listener).toHaveBeenCalledTimes(3);
    unsubscribe();
    store.setMarker(null);
    expect(listener).toHaveBeenCalledTimes(3);
  });
});

describe('derived datasets and preview (Phase 3)', () => {
  const setup = () => {
    const store = createStore();
    store.addFiles([file('format-lm63-2002.ies'), file('format-lm63-1995.ies')]);
    const [a, b] = store.getState().entries;
    return { store, a: a!, b: b! };
  };

  it('previews a result without adding it to the workspace', () => {
    const { store, a, b } = setup();
    const d = subtract(a.dataset!, b.dataset!);
    store.setPreview(d);
    expect(store.getState().preview?.dataset).toBe(d);
    expect(store.getState().preview?.summary.maxIntensity).toBe(0);
    expect(store.getState().entries).toHaveLength(2);
    store.setPreview(null);
    expect(store.getState().preview).toBeNull();
  });

  it('adds a derived dataset with an editable name, selects it, and clears the preview', () => {
    const { store, a, b } = setup();
    const d = subtract(a.dataset!, b.dataset!);
    store.setPreview(d);
    const e = store.addDerived(d, 'my difference');
    const st = store.getState();
    expect(st.entries).toHaveLength(3);
    expect(e.origin).toBe('derived');
    expect(e.name).toBe('my difference');
    expect(e.dataset?.name).toBe('my difference');
    expect(e.dataset?.kind).toBe('difference');
    expect(st.selectedKey).toBe(e.key);
    expect(st.preview).toBeNull();
    expect(d.name).not.toBe('my difference'); // the preview object itself is not modified
  });

  it('renames an entry and its dataset', () => {
    const { store, a } = setup();
    store.rename(a.key, 'low beam');
    expect(store.getState().entries[0]!.name).toBe('low beam');
    expect(store.getState().entries[0]!.dataset?.name).toBe('low beam');
    store.rename(a.key, '   ');
    expect(store.getState().entries[0]!.name).toBe('low beam'); // empty names are ignored
  });

  it('flipH does not apply to derived datasets; file entries are marked as files', () => {
    const { store, a, b } = setup();
    expect(a.origin).toBe('file');
    const e = store.addDerived(subtract(a.dataset!, b.dataset!), 'd');
    store.setFlipH(e.key, true);
    expect(store.getState().entries.find((x) => x.key === e.key)?.flipH).toBe(false);
  });

  it('selecting a dataset closes the preview; the panel tab can be switched', () => {
    const { store, a, b } = setup();
    store.setPreview(subtract(a.dataset!, b.dataset!));
    store.select(b.key);
    expect(store.getState().preview).toBeNull();
    store.setPanelTab('manipulate');
    expect(store.getState().panelTab).toBe('manipulate');
  });
});

describe('ui/ keeps files in memory only', () => {
  const sources = import.meta.glob<string>('../ui/**/*.ts', { query: '?raw', import: 'default', eager: true });
  it.each(Object.entries(sources))('%s does not use browser storage', (_f, src) => {
    expect(src).not.toMatch(/\b(localStorage|sessionStorage|indexedDB|caches\.open|document\.cookie)\b/);
  });
});
