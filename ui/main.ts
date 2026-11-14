import './styles.css';
import { APP_VERSION } from '../core/model/version';
import { createStore, type LoadedFile } from './state/store';
import { renderWorkspace } from './workspace';
import { renderInfo } from './info';
import { createViewer } from './viewer';
import { message, messageText } from '../core/messages';
import { busy } from './busy';
import { createReportPage } from './report/page';
import { createHelp } from './help';
import { exportSettings, importSettingsFile, renderSettingsNotice } from './settings-io';
import { createRoadView } from './road-view';

const MAX_FILE_BYTES = 50 * 1024 * 1024;

const versionEl = document.getElementById('app-version');
if (versionEl) versionEl.textContent = `v${APP_VERSION}`;

const store = createStore();
const workspaceEl = document.getElementById('workspace')!;
const viewerEl = document.getElementById('viewer')!;
const panelEl = document.getElementById('taskpanel')!;
const fileInput = document.getElementById('file-input') as HTMLInputElement;
const dropOverlay = document.getElementById('drop-overlay')!;

// The viewer area shows the angular viewer, or the road view while the Road tab is open.
const angularEl = document.createElement('div');
const roadEl = document.createElement('div');
viewerEl.replaceChildren(angularEl, roadEl);
const viewer = createViewer(angularEl, store);
const roadView = createRoadView(roadEl, store);
const settingsNotice = document.getElementById('settings-notice')!;
const render = () => {
  const state = store.getState();
  renderSettingsNotice(settingsNotice, state, store);
  renderWorkspace(workspaceEl, state, store);
  renderInfo(panelEl, state, store);
  const road = state.panelTab === 'road';
  angularEl.hidden = road;
  roadEl.hidden = !road;
  if (road) roadView.render(state);
  else viewer.render(state);
};
store.subscribe(render);
render();

const report = createReportPage(store);
const help = createHelp();
const reportBtn = document.getElementById('report-btn')!;
reportBtn.addEventListener('click', () => void report.open(reportBtn));
document.getElementById('settings-export')!.addEventListener('click', () => exportSettings(store.getState()));
const settingsInput = document.getElementById('settings-input') as HTMLInputElement;
settingsInput.addEventListener('change', () => {
  const f = settingsInput.files?.[0];
  if (f) void importSettingsFile(f, store);
  settingsInput.value = '';
});
const helpBtn = document.getElementById('help-btn')!;
helpBtn.addEventListener('click', () => help.open(helpBtn));

/** SHA-256 of the file content (hex), computed locally with Web Crypto; null if unavailable. */
async function sha256Hex(buf: ArrayBuffer): Promise<string | null> {
  try {
    const d = await crypto.subtle.digest('SHA-256', buf);
    return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}

/** IES files are usually ASCII; fall back to Windows-1252 for files with non-UTF-8 bytes. */
function decode(buf: ArrayBuffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('windows-1252').decode(buf);
  }
}

/** Reads files with the browser File API, in memory only, and hands them to the store. */
async function loadFiles(files: FileList | File[]): Promise<void> {
  const list = Array.from(files);
  if (!list.length) return;
  const loaded = await Promise.all(
    list.map(async (f): Promise<LoadedFile> => {
      if (!/\.ies$/i.test(f.name)) return { name: f.name, text: '', error: messageText(message('FILE.NOT_IES')) };
      if (f.size > MAX_FILE_BYTES) return { name: f.name, text: '', error: messageText(message('FILE.TOO_LARGE')) };
      try {
        const buf = await f.arrayBuffer();
        return { name: f.name, text: decode(buf), sha256: await sha256Hex(buf) };
      } catch (e) {
        console.error(e);
        return { name: f.name, text: '', error: messageText(message('FILE.UNREADABLE')) };
      }
    }),
  );
  await busy(`Loading ${loaded.length} file(s)`, () => store.addFiles(loaded));
}

fileInput.addEventListener('change', () => {
  if (fileInput.files) void loadFiles(fileInput.files);
  fileInput.value = ''; // allow loading the same file again
});

// Drag and drop anywhere on the page
const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  dragDepth++;
  dropOverlay.hidden = false;
});
window.addEventListener('dragleave', (e) => {
  if (!hasFiles(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) dropOverlay.hidden = true;
});
window.addEventListener('dragover', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
});
window.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  dropOverlay.hidden = true;
  if (e.dataTransfer?.files) void loadFiles(e.dataTransfer.files);
});
