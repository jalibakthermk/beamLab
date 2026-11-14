/**
 * Settings file (Phase 8): all settings as JSON, never file content.
 * Datasets are referred to by file name and SHA-256 of the file content; on
 * import they are matched against the loaded files by hash. Inside the
 * sections, a reference to a file is the string "@file:<ref>".
 */

export const SETTINGS_FORMAT = 'beamLab-settings';
export const SETTINGS_VERSION = 1;

export interface FileRef {
  /** Short id used inside the settings, e.g. "f1". */
  ref: string;
  name: string;
  /** SHA-256 of the file content, lower-case hex. */
  sha256: string;
  flipH: boolean;
}

export interface SettingsFile {
  format: typeof SETTINGS_FORMAT;
  version: number;
  appVersion: string;
  saved: string;
  files: FileRef[];
  /** Named sections (view, evaluate, cutoff, road, report, selection). */
  sections: Record<string, unknown>;
  notes: string[];
}

export class SettingsError extends Error {
  override name = 'SettingsError';
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`Invalid settings file:\n- ${problems.join('\n- ')}`);
    this.problems = problems;
  }
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const HEX64 = /^[0-9a-f]{64}$/;

export const fileToken = (ref: string) => `@file:${ref}`;
const TOKEN = /^@file:(.+)$/;

export function parseSettings(obj: unknown): SettingsFile {
  const p: string[] = [];
  if (!isObj(obj)) throw new SettingsError(['(root): must be an object']);
  if (obj['format'] !== SETTINGS_FORMAT) p.push(`format: must be "${SETTINGS_FORMAT}"`);
  if (typeof obj['version'] !== 'number' || !Number.isInteger(obj['version']) || obj['version'] < 1) p.push('version: must be a whole number ≥ 1');
  if (typeof obj['appVersion'] !== 'string') p.push('appVersion: must be a string');
  if (typeof obj['saved'] !== 'string') p.push('saved: must be a string');
  const files = obj['files'];
  const refs = new Set<string>();
  if (!Array.isArray(files)) p.push('files: must be a list');
  else
    files.forEach((f, i) => {
      if (!isObj(f)) return p.push(`files[${i}]: must be an object`);
      if (typeof f['ref'] !== 'string' || !f['ref']) p.push(`files[${i}].ref: must be a string`);
      else if (refs.has(f['ref'])) p.push(`files[${i}].ref: duplicate "${f['ref']}"`);
      else refs.add(f['ref']);
      if (typeof f['name'] !== 'string') p.push(`files[${i}].name: must be a string`);
      if (typeof f['sha256'] !== 'string' || !HEX64.test(f['sha256'])) p.push(`files[${i}].sha256: must be 64 hex characters`);
      if (typeof f['flipH'] !== 'boolean') p.push(`files[${i}].flipH: must be true or false`);
      const extra = Object.keys(f).filter((k) => !['ref', 'name', 'sha256', 'flipH'].includes(k));
      if (extra.length) p.push(`files[${i}]: unexpected field(s) ${extra.join(', ')} (settings never hold file content)`);
    });
  if (!isObj(obj['sections'])) p.push('sections: must be an object');
  if (obj['notes'] !== undefined && !(Array.isArray(obj['notes']) && obj['notes'].every((n) => typeof n === 'string'))) p.push('notes: must be a list of strings');
  // Every file token must name a listed file
  const walk = (x: unknown, path: string): void => {
    if (typeof x === 'string') {
      const m = TOKEN.exec(x);
      if (m && !refs.has(m[1]!)) p.push(`${path}: refers to unknown file "${m[1]}"`);
    } else if (Array.isArray(x)) x.forEach((y, i) => walk(y, `${path}[${i}]`));
    else if (isObj(x)) for (const [k, y] of Object.entries(x)) walk(y, `${path}.${k}`);
  };
  if (isObj(obj['sections'])) walk(obj['sections'], 'sections');
  if (p.length) throw new SettingsError(p);
  return { notes: [], ...(obj as object) } as unknown as SettingsFile;
}

export interface LoadedFileId {
  key: string;
  name: string;
  sha256: string | null;
  flipH: boolean;
}

export type MatchStatus = 'matched' | 'missing' | 'hash-mismatch';
export interface FileMatch {
  file: FileRef;
  status: MatchStatus;
  /** Workspace key of the matching file. */
  key: string | null;
}

/**
 * Matches the settings' files against the loaded files by SHA-256 (and the
 * mirror flag). A file with the same name but different content is reported
 * as a hash mismatch and never used.
 */
export function matchFiles(files: FileRef[], loaded: LoadedFileId[]): FileMatch[] {
  const used = new Set<string>();
  return files.map((f) => {
    const hit = loaded.find((l) => !used.has(l.key) && l.sha256 === f.sha256 && l.flipH === f.flipH) ?? loaded.find((l) => !used.has(l.key) && l.sha256 === f.sha256);
    if (hit) {
      used.add(hit.key);
      return { file: f, status: 'matched', key: hit.key };
    }
    return { file: f, status: loaded.some((l) => l.name === f.name) ? 'hash-mismatch' : 'missing', key: null };
  });
}

/** Replaces "@file:<ref>" strings with workspace keys (null where not matched). */
export function resolveRefs<T>(x: T, matches: FileMatch[]): T {
  const map = new Map(matches.map((m) => [m.file.ref, m.key]));
  const walk = (y: unknown): unknown => {
    if (typeof y === 'string') {
      const m = TOKEN.exec(y);
      return m ? (map.get(m[1]!) ?? null) : y;
    }
    if (Array.isArray(y)) return y.map(walk);
    if (isObj(y)) return Object.fromEntries(Object.entries(y).map(([k, v]) => [k, walk(v)]));
    return y;
  };
  return walk(x) as T;
}

/**
 * Copies values from `incoming` onto `defaults` where they fit: same type as
 * the default (or null where the default may be null). Unknown keys are
 * dropped; objects are merged recursively; arrays are taken as they are when
 * the default is an array (items are checked by the caller).
 */
export function mergeKnown<T>(defaults: T, incoming: unknown, nullable: ReadonlySet<string> = new Set(), path = ''): T {
  if (!isObj(defaults) || !isObj(incoming)) return defaults;
  const out: Record<string, unknown> = { ...defaults };
  for (const [k, d] of Object.entries(defaults)) {
    if (!(k in incoming)) continue;
    const v = incoming[k];
    const here = path ? `${path}.${k}` : k;
    if (v === null && (d === null || nullable.has(here))) out[k] = null;
    else if (Array.isArray(d)) {
      if (Array.isArray(v)) out[k] = v;
    } else if (isObj(d)) out[k] = mergeKnown(d, v, nullable, here);
    else if (d === null ? v !== undefined && (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') : typeof v === typeof d && (typeof v !== 'number' || Number.isFinite(v))) out[k] = v;
  }
  return out as T;
}
