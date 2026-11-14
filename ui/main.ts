import './styles.css';
import { APP_VERSION } from '../core/model/version';
import { createStore, type LoadedFile } from './state/store';
import { renderWorkspace } from './workspace';
import { renderInfo } from './info';
import { createViewer } from './viewer';
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
const render = () => {
  const state = store.getState();
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
      if (!/\.ies$/i.test(f.name)) return { name: f.name, text: '', error: 'Not an .ies file.' };
      if (f.size > MAX_FILE_BYTES) return { name: f.name, text: '', error: 'File is larger than 50 MB.' };
      try {
        return { name: f.name, text: decode(await f.arrayBuffer()) };
      } catch (e) {
        return { name: f.name, text: '', error: `Could not read the file: ${e instanceof Error ? e.message : String(e)}` };
      }
    }),
  );
  store.addFiles(loaded);
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
