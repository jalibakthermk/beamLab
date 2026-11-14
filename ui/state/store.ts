import { parseIes, type IesWarning } from '../../core/io/ies';
import { summarize, type DatasetSummary } from '../../core/analysis/summary';
import type { IntensityScale } from '../../core/analysis/levels';
import type { PhotometricDataset } from '../../core/model/dataset';

/**
 * Plain app-state store (no framework, no DOM).
 * Files are held in memory only; nothing is written to any browser storage.
 */

export interface LoadedFile {
  name: string;
  text: string;
  /** Set by the loader when the file could not be read (e.g. wrong type); it is then not parsed. */
  error?: string;
}

export interface Entry {
  /** Unique per loaded file (the same file can be loaded twice). */
  key: string;
  name: string;
  /** Source text, kept in memory so flipH can reload the file. */
  text: string;
  flipH: boolean;
  dataset: PhotometricDataset | null;
  summary: DatasetSummary | null;
  warnings: IesWarning[];
  /** Set when the file could not be parsed. */
  error: string | null;
}

export type ViewMode = 'contour' | 'heatmap';

export interface ViewSettings {
  mode: ViewMode;
  scale: IntensityScale;
  levelsMode: 'auto' | 'custom';
  /** User contour levels in cd. */
  customLevels: number[];
  /** Cross-section marker (degrees), set by clicking the viewer. */
  marker: { h: number; v: number } | null;
}

export interface AppState {
  entries: Entry[];
  selectedKey: string | null;
  overlayKey: string | null;
  view: ViewSettings;
}

export type Listener = (state: AppState) => void;

export interface Store {
  getState(): AppState;
  subscribe(listener: Listener): () => void;
  addFiles(files: LoadedFile[]): Entry[];
  remove(key: string): void;
  select(key: string): void;
  setOverlay(key: string | null): void;
  setFlipH(key: string, flipH: boolean): void;
  setView(patch: Partial<Omit<ViewSettings, 'marker'>>): void;
  setMarker(marker: { h: number; v: number } | null): void;
}

function load(key: string, name: string, text: string, flipH: boolean): Entry {
  try {
    const { dataset, warnings } = parseIes(text, { name, flipH });
    return { key, name, text, flipH, dataset, summary: summarize(dataset), warnings, error: null };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { key, name, text, flipH, dataset: null, summary: null, warnings: [], error: message };
  }
}

export function createStore(): Store {
  let state: AppState = {
    entries: [],
    selectedKey: null,
    overlayKey: null,
    view: { mode: 'contour', scale: 'linear', levelsMode: 'auto', customLevels: [], marker: null },
  };
  const listeners = new Set<Listener>();
  let counter = 0;

  const set = (next: AppState) => {
    state = next;
    for (const l of listeners) l(state);
  };
  const usable = (key: string | null) => state.entries.some((e) => e.key === key && e.dataset !== null);

  return {
    getState: () => state,

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    addFiles(files) {
      const added = files.map((f): Entry => {
        const key = `f${++counter}`;
        if (f.error !== undefined) {
          return { key, name: f.name, text: '', flipH: false, dataset: null, summary: null, warnings: [], error: f.error };
        }
        return load(key, f.name, f.text, false);
      });
      const firstGood = added.find((e) => e.dataset !== null);
      set({
        ...state,
        entries: [...state.entries, ...added],
        selectedKey: state.selectedKey ?? firstGood?.key ?? null,
      });
      return added;
    },

    remove(key) {
      const entries = state.entries.filter((e) => e.key !== key);
      let selectedKey = state.selectedKey;
      if (selectedKey === key) {
        const idx = state.entries.findIndex((e) => e.key === key);
        const after = entries.slice(idx).find((e) => e.dataset);
        const before = entries.slice(0, idx).reverse().find((e) => e.dataset);
        selectedKey = (after ?? before)?.key ?? null;
      }
      let overlayKey = state.overlayKey === key ? null : state.overlayKey;
      if (overlayKey === selectedKey) overlayKey = null;
      set({ ...state, entries, selectedKey, overlayKey });
    },

    select(key) {
      if (!usable(key)) return;
      set({ ...state, selectedKey: key, overlayKey: state.overlayKey === key ? null : state.overlayKey });
    },

    setOverlay(key) {
      if (key !== null && (!usable(key) || key === state.selectedKey)) return;
      set({ ...state, overlayKey: key });
    },

    setFlipH(key, flipH) {
      set({
        ...state,
        entries: state.entries.map((e) => (e.key === key && e.flipH !== flipH ? load(e.key, e.name, e.text, flipH) : e)),
      });
    },

    setView(patch) {
      set({ ...state, view: { ...state.view, ...patch } });
    },

    setMarker(marker) {
      set({ ...state, view: { ...state.view, marker } });
    },
  };
}
