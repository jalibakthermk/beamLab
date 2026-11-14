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
  /** Unique per entry (the same file can be loaded twice). */
  key: string;
  name: string;
  /** 'file': loaded from an IES file. 'derived': result of an operation. */
  origin: 'file' | 'derived';
  /** Source text, kept in memory so flipH can reload the file ('' for derived datasets). */
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

export interface Preview {
  /** A result shown in the viewer but not (yet) in the workspace. */
  dataset: PhotometricDataset;
  summary: DatasetSummary;
}

export type PanelTab = 'info' | 'manipulate';

export interface AppState {
  entries: Entry[];
  selectedKey: string | null;
  overlayKey: string | null;
  view: ViewSettings;
  preview: Preview | null;
  panelTab: PanelTab;
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
  /** Shows a result in the viewer without adding it to the workspace (null closes the preview). */
  setPreview(dataset: PhotometricDataset | null): void;
  /** Adds an operation result to the workspace under the given name, selects it and closes the preview. */
  addDerived(dataset: PhotometricDataset, name: string): Entry;
  rename(key: string, name: string): void;
  setPanelTab(tab: PanelTab): void;
}

function load(key: string, name: string, text: string, flipH: boolean): Entry {
  try {
    const { dataset, warnings } = parseIes(text, { name, flipH });
    return { key, name, origin: 'file', text, flipH, dataset, summary: summarize(dataset), warnings, error: null };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { key, name, origin: 'file', text, flipH, dataset: null, summary: null, warnings: [], error: message };
  }
}

export function createStore(): Store {
  let state: AppState = {
    entries: [],
    selectedKey: null,
    overlayKey: null,
    view: { mode: 'contour', scale: 'linear', levelsMode: 'auto', customLevels: [], marker: null },
    preview: null,
    panelTab: 'info',
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
          return { key, name: f.name, origin: 'file', text: '', flipH: false, dataset: null, summary: null, warnings: [], error: f.error };
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
      set({ ...state, selectedKey: key, overlayKey: state.overlayKey === key ? null : state.overlayKey, preview: null });
    },

    setOverlay(key) {
      if (key !== null && (!usable(key) || key === state.selectedKey)) return;
      set({ ...state, overlayKey: key });
    },

    setFlipH(key, flipH) {
      set({
        ...state,
        entries: state.entries.map((e) =>
          e.key === key && e.origin === 'file' && e.flipH !== flipH ? load(e.key, e.name, e.text, flipH) : e,
        ),
      });
    },

    setView(patch) {
      set({ ...state, view: { ...state.view, ...patch } });
    },

    setMarker(marker) {
      set({ ...state, view: { ...state.view, marker } });
    },

    setPreview(dataset) {
      set({ ...state, preview: dataset ? { dataset, summary: summarize(dataset) } : null });
    },

    addDerived(dataset, name) {
      const clean = name.trim() || dataset.name;
      const ds = { ...dataset, name: clean };
      const entry: Entry = {
        key: `d${++counter}`,
        name: clean,
        origin: 'derived',
        text: '',
        flipH: false,
        dataset: ds,
        summary: summarize(ds),
        warnings: [],
        error: null,
      };
      const overlayKey = state.overlayKey === entry.key ? null : state.overlayKey;
      set({ ...state, entries: [...state.entries, entry], selectedKey: entry.key, overlayKey, preview: null });
      return entry;
    },

    rename(key, name) {
      const clean = name.trim();
      if (!clean) return;
      set({
        ...state,
        entries: state.entries.map((e) =>
          e.key === key ? { ...e, name: clean, dataset: e.dataset ? { ...e.dataset, name: clean } : null } : e,
        ),
      });
    },

    setPanelTab(tab) {
      set({ ...state, panelTab: tab });
    },
  };
}
