import { messageText, toUserMessage } from '../../core/messages';
import { parseIes, type IesWarning } from '../../core/io/ies';
import { summarize, type DatasetSummary } from '../../core/analysis/summary';
import type { IntensityScale } from '../../core/analysis/levels';
import type { PhotometricDataset } from '../../core/model/dataset';
import type { RotationReport } from '../../core/geometry/rotate';
import { DEFAULT_REPORT_OPTIONS, type ReportOptions } from '../../core/report/build';
import type { FileMatch, SettingsFile } from '../../core/settings';
import { resolveImport, settingsSections } from './settings';

/**
 * Plain app-state store (no framework, no DOM).
 * Files are held in memory only; nothing is written to any browser storage.
 */

export interface LoadedFile {
  name: string;
  text: string;
  /** SHA-256 of the file content (hex), computed locally with Web Crypto. */
  sha256?: string | null;
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
  /** SHA-256 of the file content (hex); null for derived datasets or if it could not be computed. */
  sha256: string | null;
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
  /** Drawn dashed for comparison (e.g. the dataset before rotation). */
  compareTo: PhotometricDataset | null;
  /** Report of the rotation that produced the preview, if any. */
  report: RotationReport | null;
}

export type PanelTab = 'info' | 'evaluate' | 'road' | 'manipulate' | 'cutoff';

/** One lamp on the Road tab. null = not entered yet (there are no hidden defaults). */
export interface RoadLampSettings {
  entryKey: string | null;
  mirror: boolean;
  x: number | null;
  y: number | null;
  height: number | null;
  yaw: number | null;
  pitch: number | null;
  roll: number | null;
}

/** Road tab settings. Mounting, aim and lane values start empty; the grid has tool defaults. */
export interface RoadSettings {
  lamps: RoadLampSettings[];
  pair: {
    leftKey: string | null;
    /** null: the left file is used for both lamps. */
    rightKey: string | null;
    mirror: 'none' | 'left' | 'right';
    separation: number | null;
    height: number | null;
    x: number | null;
    yaw: number | null;
    pitch: number | null;
    roll: number | null;
    /** Right lamp aim: mirror image of the left (yaw and roll change sign) or the same. */
    rightAim: 'mirrored' | 'same';
  };
  lanes: { laneWidth: number | null; lanes: number | null; trafficSide: 'right' | 'left' | null; ownLane: number | null; offset: number | null };
  grid: { xMin: number; xMax: number; xStep: number; yMin: number; yMax: number; yStep: number };
  levelsText: string;
  widthText: string;
  widthLevel: number | null;
  pointsText: string;
  outsideZero: boolean;
  equalAxes: boolean;
  reqKey: string | null;
}

export const EMPTY_ROAD_LAMP: RoadLampSettings = { entryKey: null, mirror: false, x: null, y: null, height: null, yaw: null, pitch: null, roll: null };

export const DEFAULT_ROAD: RoadSettings = {
  lamps: [],
  pair: { leftKey: null, rightKey: null, mirror: 'none', separation: null, height: null, x: null, yaw: null, pitch: null, roll: null, rightAim: 'mirrored' },
  lanes: { laneWidth: null, lanes: null, trafficSide: null, ownLane: null, offset: null },
  grid: { xMin: 0, xMax: 150, xStep: 0.5, yMin: -15, yMax: 15, yStep: 0.25 },
  levelsText: '',
  widthText: '',
  widthLevel: null,
  pointsText: '',
  outsideZero: false,
  equalAxes: false,
  reqKey: null,
};

/** Evaluate tab settings. */
export interface EvaluateSettings {
  regId: string | null;
  traffic: 'RHT' | 'LHT';
  aimMode: 'as-loaded' | 'aim-to-cutoff' | 're-aim-search';
  scaleFactor: number;
  lamps: number;
  /** Highlighted element (table row and overlay). */
  selected: string | null;
  sortByMargin: boolean;
}

/** Cut-off tab settings. Defaults are tool defaults, not regulation values. */
export interface CutoffSettings {
  /** Selected preset (data/presets/cutoff); its non-null values override the fields below. */
  presetId: string | null;
  scanH: number;
  vMin: number;
  vMax: number;
  step: number;
  traffic: 'RHT' | 'LHT';
  /** Trace H range and step. */
  hMin: number;
  hMax: number;
  hStep: number;
  /** Aim target: cut-off V in percent down or degrees. */
  targetValue: number;
  targetUnit: 'percent' | 'deg';
  elbowAtZero: boolean;
}

export const DEFAULT_CUTOFF: CutoffSettings = {
  presetId: null, scanH: -2, vMin: -3, vMax: 2, step: 0.05, traffic: 'RHT',
  hMin: -8, hMax: 8, hStep: 0.5, targetValue: 1, targetUnit: 'percent', elbowAtZero: true,
};

export interface AppState {
  entries: Entry[];
  selectedKey: string | null;
  overlayKey: string | null;
  view: ViewSettings;
  preview: Preview | null;
  panelTab: PanelTab;
  cutoff: CutoffSettings;
  evaluate: EvaluateSettings;
  road: RoadSettings;
  report: ReportOptions;
  /** Settings imported from a file, waiting for (or matched with) the files they refer to. */
  settingsImport: { file: SettingsFile; matches: FileMatch[]; signature: string | null } | null;
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
  setPreview(dataset: PhotometricDataset | null, extras?: { compareTo?: PhotometricDataset; report?: RotationReport }): void;
  /** Adds an operation result to the workspace under the given name, selects it and closes the preview. */
  addDerived(dataset: PhotometricDataset, name: string): Entry;
  rename(key: string, name: string): void;
  setPanelTab(tab: PanelTab): void;
  setCutoff(patch: Partial<CutoffSettings>): void;
  setEvaluate(patch: Partial<EvaluateSettings>): void;
  setRoad(patch: Partial<RoadSettings>): void;
  setReport(patch: Partial<ReportOptions>): void;
  /** Applies a settings file; references to files are resolved as matching files are loaded. */
  importSettings(file: SettingsFile): void;
  clearSettingsImport(): void;
}

function load(key: string, name: string, text: string, flipH: boolean, sha256: string | null): Entry {
  try {
    const { dataset, warnings } = parseIes(text, { name, flipH });
    return { key, name, origin: 'file', text, sha256, flipH, dataset, summary: summarize(dataset), warnings, error: null };
  } catch (e) {
    const message = messageText(toUserMessage(e));
    return { key, name, origin: 'file', text, sha256, flipH, dataset: null, summary: null, warnings: [], error: message };
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
    cutoff: { ...DEFAULT_CUTOFF },
    evaluate: { regId: null, traffic: 'RHT', aimMode: 'as-loaded', scaleFactor: 1, lamps: 1, selected: null, sortByMargin: false },
    road: structuredClone(DEFAULT_ROAD),
    report: structuredClone(DEFAULT_REPORT_OPTIONS),
    settingsImport: null,
  };
  const listeners = new Set<Listener>();
  let counter = 0;

  const set = (next: AppState) => {
    state = next.settingsImport ? resolveImport(next) : next;
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
          return { key, name: f.name, origin: 'file', text: '', sha256: f.sha256 ?? null, flipH: false, dataset: null, summary: null, warnings: [], error: f.error };
        }
        return load(key, f.name, f.text, false, f.sha256 ?? null);
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
          e.key === key && e.origin === 'file' && e.flipH !== flipH ? load(e.key, e.name, e.text, flipH, e.sha256) : e,
        ),
      });
    },

    setView(patch) {
      set({ ...state, view: { ...state.view, ...patch } });
    },

    setMarker(marker) {
      set({ ...state, view: { ...state.view, marker } });
    },

    setPreview(dataset, extras = {}) {
      set({
        ...state,
        preview: dataset
          ? { dataset, summary: summarize(dataset), compareTo: extras.compareTo ?? null, report: extras.report ?? null }
          : null,
      });
    },

    addDerived(dataset, name) {
      const clean = name.trim() || dataset.name;
      const ds = { ...dataset, name: clean };
      const entry: Entry = {
        key: `d${++counter}`,
        name: clean,
        origin: 'derived',
        text: '',
        sha256: null,
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

    setCutoff(patch) {
      set({ ...state, cutoff: { ...state.cutoff, ...patch } });
    },

    setEvaluate(patch) {
      set({ ...state, evaluate: { ...state.evaluate, ...patch } });
    },

    setRoad(patch) {
      set({ ...state, road: { ...state.road, ...patch } });
    },

    setReport(patch) {
      set({ ...state, report: { ...state.report, ...patch } });
    },

    importSettings(file) {
      set({ ...state, ...settingsSections(file), settingsImport: { file, matches: [], signature: null } });
    },

    clearSettingsImport() {
      set({ ...state, settingsImport: null });
    },
  };
}
