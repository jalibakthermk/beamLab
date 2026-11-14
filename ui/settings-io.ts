import type { AppState, Store } from './state/store';
import { el } from './dom';
import { downloadText } from './download';
import { settingsFromState } from './state/settings';
import { parseSettings, SETTINGS_VERSION } from '../core/settings';
import { APP_VERSION } from '../core/model/version';
import { message, messageText, toUserMessage } from '../core/messages';

/** Settings export / import (header buttons) and the import status notice (Phase 8). */

let importError = '';

export function exportSettings(state: AppState): void {
  const sf = settingsFromState(state, APP_VERSION, new Date().toISOString());
  downloadText(`beamLab-settings-${sf.saved.slice(0, 10)}.json`, JSON.stringify(sf, null, 2) + '\n', 'application/json');
}

export async function importSettingsFile(file: File, store: Store): Promise<void> {
  try {
    const sf = parseSettings(JSON.parse(await file.text()));
    importError = sf.version > SETTINGS_VERSION ? messageText(message('SETTINGS.NEWER')) : '';
    store.importSettings(sf);
  } catch (e) {
    importError = `${file.name}: ${messageText(toUserMessage(e))}`;
    store.clearSettingsImport();
  }
}

/** Notice listing the files to load again and whether each matched by SHA-256. */
export function renderSettingsNotice(root: HTMLElement, state: AppState, store: Store): void {
  const imp = state.settingsImport;
  if (!imp && !importError) {
    root.replaceChildren();
    root.hidden = true;
    return;
  }
  root.hidden = false;
  const parts: HTMLElement[] = [];
  if (importError) parts.push(el('p', { class: 'export-msg', attrs: { role: 'alert' }, text: importError }));
  if (imp) {
    const icon = { matched: '✓ matched', missing: '– load this file', 'hash-mismatch': '✗ different content (SHA-256 does not match)' } as const;
    const pending = imp.matches.filter((m) => m.status !== 'matched').length;
    parts.push(
      el('p', { text: imp.file.files.length ? (pending ? `Settings imported. Load these files again (matched by SHA-256): ${pending} of ${imp.file.files.length} still needed.` : 'Settings imported; all files matched by SHA-256.') : 'Settings imported (no files referenced).' }),
      el('ul', { class: 'warnings' }, imp.matches.map((m) => el('li', { class: m.status === 'matched' ? 'w-info' : 'w-warn', text: `${icon[m.status]}: ${m.file.name}${m.file.flipH ? ' (mirrored)' : ''} — SHA-256 ${m.file.sha256.slice(0, 12)}…` }))),
      ...imp.file.notes.map((n) => el('p', { class: 'small', text: n })),
    );
  }
  parts.push(el('button', { class: 'btn', text: 'Dismiss', on: { click: () => { importError = ''; store.clearSettingsImport(); } } }));
  root.replaceChildren(...parts);
}
