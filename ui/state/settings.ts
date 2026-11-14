import type { AppState, CutoffSettings, EvaluateSettings, RoadLampSettings, RoadSettings, ViewSettings } from './store';
import { DEFAULT_CUTOFF, DEFAULT_ROAD, EMPTY_ROAD_LAMP } from './store';
import { DEFAULT_REPORT_OPTIONS, type ReportOptions } from '../../core/report/build';
import { fileToken, matchFiles, mergeKnown, resolveRefs, SETTINGS_FORMAT, SETTINGS_VERSION, type FileRef, type SettingsFile } from '../../core/settings';

/**
 * Maps the app state to a settings file and back (Phase 8). No DOM: tested in Node.
 * Only settings are written: file names and SHA-256 hashes, never file content.
 */

const DEFAULT_VIEW: Omit<ViewSettings, 'marker'> = { mode: 'contour', scale: 'linear', levelsMode: 'auto', customLevels: [] };
const DEFAULT_EVALUATE: Omit<EvaluateSettings, 'selected'> = { regId: null, traffic: 'RHT', aimMode: 'as-loaded', scaleFactor: 1, lamps: 1, sortByMargin: false };

export function settingsFromState(state: AppState, appVersion: string, saved: string): SettingsFile {
  const files: FileRef[] = [];
  const tokenOf = new Map<string, string>();
  for (const e of state.entries) {
    if (e.origin !== 'file' || !e.dataset || !e.sha256) continue;
    const ref = `f${files.length + 1}`;
    files.push({ ref, name: e.name, sha256: e.sha256, flipH: e.flipH });
    tokenOf.set(e.key, fileToken(ref));
  }
  const tok = (key: string | null) => (key === null ? null : (tokenOf.get(key) ?? null));
  const notes: string[] = [];
  const derived = state.entries.filter((e) => e.origin === 'derived').map((e) => e.name);
  if (derived.length) notes.push(`Derived datasets are not saved (recreate them on the Manipulate tab): ${derived.join(', ')}.`);
  if (state.evaluate.regId?.startsWith('file:')) notes.push('The regulation file was loaded from disk; load it again after importing.');
  if (state.road.reqKey?.startsWith('file:')) notes.push('The requirement file was loaded from disk; load it again after importing.');
  const { marker: _marker, ...view } = state.view;
  const { selected: _selected, ...evaluate } = state.evaluate;
  const road: RoadSettings = {
    ...state.road,
    lamps: state.road.lamps.map((l) => ({ ...l, entryKey: tok(l.entryKey) })),
    pair: { ...state.road.pair, leftKey: tok(state.road.pair.leftKey), rightKey: tok(state.road.pair.rightKey) },
  };
  return {
    format: SETTINGS_FORMAT,
    version: SETTINGS_VERSION,
    appVersion,
    saved,
    files,
    sections: {
      selection: { selected: tok(state.selectedKey), overlay: tok(state.overlayKey) },
      view,
      evaluate,
      cutoff: state.cutoff,
      road,
      report: state.report,
      panelTab: state.panelTab,
    },
    notes,
  };
}

function numbers(obj: unknown, key: string): number[] {
  const v = typeof obj === 'object' && obj !== null ? (obj as Record<string, unknown>)[key] : undefined;
  return Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number' && Number.isFinite(x)) : [];
}

/** The parts of a settings file that do not refer to files. */
export function settingsSections(f: SettingsFile): Partial<AppState> {
  const s = f.sections;
  const tabs = ['info', 'evaluate', 'road', 'manipulate', 'cutoff'];
  const report = mergeKnown<ReportOptions>(DEFAULT_REPORT_OPTIONS, s['report']);
  return {
    view: { ...mergeKnown(DEFAULT_VIEW, s['view']), customLevels: numbers(s['view'], 'customLevels'), marker: null },
    evaluate: { ...mergeKnown(DEFAULT_EVALUATE, s['evaluate']), selected: null },
    cutoff: mergeKnown<CutoffSettings>(DEFAULT_CUTOFF, s['cutoff']),
    report,
    ...(typeof s['panelTab'] === 'string' && tabs.includes(s['panelTab']) ? { panelTab: s['panelTab'] as AppState['panelTab'] } : {}),
  };
}

/**
 * Matches the imported settings' files with the loaded ones (by SHA-256) and
 * applies the parts that refer to files. Runs again only when the matches
 * change, so later edits are not overwritten.
 */
export function resolveImport(state: AppState): AppState {
  const imp = state.settingsImport!;
  const loaded = state.entries.filter((e) => e.origin === 'file' && e.dataset).map((e) => ({ key: e.key, name: e.name, sha256: e.sha256, flipH: e.flipH }));
  const matches = matchFiles(imp.file.files, loaded);
  const signature = JSON.stringify(matches.map((m) => [m.file.ref, m.status, m.key]));
  if (signature === imp.signature) return state;
  const s = imp.file.sections;
  const road = resolveRefs(s['road'], matches) as Partial<RoadSettings> | undefined;
  const merged = mergeKnown<RoadSettings>(DEFAULT_ROAD, road);
  merged.lamps = (Array.isArray(road?.lamps) ? road.lamps : []).map((l) => mergeKnown<RoadLampSettings>(EMPTY_ROAD_LAMP, l));
  const sel = resolveRefs(s['selection'], matches) as { selected?: string | null; overlay?: string | null } | undefined;
  const has = (k: string | null | undefined) => (k && state.entries.some((e) => e.key === k && e.dataset) ? k : null);
  const selectedKey = has(sel?.selected) ?? state.selectedKey;
  const overlay = has(sel?.overlay);
  return {
    ...state,
    road: merged,
    selectedKey,
    overlayKey: overlay !== selectedKey ? overlay : null,
    settingsImport: { ...imp, matches, signature },
  };
}
