import type { AppState, PanelTab, Store } from './state/store';
import { el } from './dom';
import { baseName, fmtDeg, fmtLm, fmtStep, fmtValue, KIND_LABEL, type Kind } from './format';
import { downloadText } from './download';
import { renderManipulate } from './manipulate';
import { renderCutoff } from './cutoff';
import { renderEvaluate } from './evaluate';
import { exportIes, ExportError } from '../core/io/export';
import { exportCsv } from '../core/io/csv';
import { sample } from '../core/geometry/interpolate';
import { valueRange } from '../core/analysis/levels';
import { provenanceChain } from '../core/model/provenance';

// Probe inputs survive re-renders of the panel (kept in memory only).
const probe = { h: '', v: '' };

const TABS: Array<{ label: string; tab: PanelTab | null }> = [
  { label: 'Info', tab: 'info' },
  { label: 'Evaluate', tab: 'evaluate' },
  { label: 'Road', tab: null },
  { label: 'Manipulate', tab: 'manipulate' },
  { label: 'Cut-off', tab: 'cutoff' },
];

function row(label: string, value: string | Node): HTMLElement[] {
  return [el('dt', { text: label }), el('dd', {}, [value])];
}

/** Task panel: tabs plus the active tab's content. */
export function renderInfo(root: HTMLElement, state: AppState, store: Store): void {
  const tabs = el(
    'div',
    { class: 'tabs', attrs: { role: 'tablist' } },
    TABS.map(({ label, tab }) => {
      const active = tab === state.panelTab;
      const b = el('button', {
        class: active ? 'tab active' : 'tab',
        text: label,
        attrs: { role: 'tab', 'aria-selected': String(active) },
        title: tab ? '' : 'Coming in a later phase',
        on: { click: () => tab && store.setPanelTab(tab) },
      });
      b.disabled = tab === null;
      return b;
    }),
  );
  const body = el('div', { class: 'pad' });
  root.replaceChildren(tabs, body);
  if (state.panelTab === 'manipulate') renderManipulate(body, state, store);
  else if (state.panelTab === 'cutoff') renderCutoff(body, state, store);
  else if (state.panelTab === 'evaluate') renderEvaluate(body, state, store);
  else renderInfoBody(body, state, store);
}

function renderInfoBody(root: HTMLElement, state: AppState, store: Store): void {
  const entry = state.entries.find((e) => e.key === state.selectedKey);
  const preview = state.preview;
  const ds = preview?.dataset ?? entry?.dataset ?? null;
  const s = preview?.summary ?? entry?.summary ?? null;
  if (!ds || !s) {
    root.replaceChildren(el('p', { class: 'muted', text: 'Load and select a dataset to see its details.' }));
    return;
  }
  const kind = ds.kind as Kind;
  const isFile = !preview && entry?.origin === 'file';
  const warnings = preview ? [] : (entry?.warnings ?? []);
  const conv = ds.provenance?.params['conversion'] as { from: string; targetStep: number } | null | undefined;
  const symmetry = ds.provenance?.params['symmetry'] as string | null | undefined;
  const range = valueRange(ds.values);

  // Name: editable for workspace entries
  const heading = preview
    ? el('h2', { class: 'break', text: `Preview: ${ds.name}` })
    : (() => {
        const i = el('input', { class: 'name-input title-input', attrs: { type: 'text', 'aria-label': 'Dataset name' } });
        i.value = entry!.name;
        i.addEventListener('change', () => store.rename(entry!.key, i.value));
        return i;
      })();

  const flip = el('input', {
    attrs: { type: 'checkbox' },
    on: { change: (ev) => entry && store.setFlipH(entry.key, (ev.target as HTMLInputElement).checked) },
  });
  flip.checked = entry?.flipH ?? false;

  const exportMsg = el('p', { class: 'export-msg', attrs: { role: 'status' } });
  const fileBase =
    baseName(ds.name.replace(/\.ies\b/gi, '')).replace(/[^\w.-]+/g, '_').replace(/_+/g, '_') + (entry?.flipH && !preview ? '-mirrored' : '');
  const exportIesBtn = el('button', {
    class: 'btn',
    text: 'Export IES',
    title: kind === 'intensity' ? '' : 'Only intensity datasets can be exported as IES',
    on: {
      click: () => {
        try {
          downloadText(`${fileBase}-beamLab.ies`, exportIes(ds), 'text/plain');
          exportMsg.textContent = '';
        } catch (e) {
          exportMsg.textContent = e instanceof ExportError ? e.message : String(e);
        }
      },
    },
  });
  const exportCsvBtn = el('button', {
    class: 'btn',
    text: 'Export CSV',
    on: { click: () => downloadText(`${fileBase}-beamLab.csv`, exportCsv(ds), 'text/csv') },
  });

  const probeH = el('input', { class: 'probe-input', attrs: { type: 'text', inputmode: 'decimal', 'aria-label': 'Probe H in degrees', placeholder: 'H °' } });
  const probeV = el('input', { class: 'probe-input', attrs: { type: 'text', inputmode: 'decimal', 'aria-label': 'Probe V in degrees', placeholder: 'V °' } });
  probeH.value = probe.h;
  probeV.value = probe.v;
  const probeOut = el('p', { class: 'probe-out', attrs: { role: 'status' } });
  const runProbe = () => {
    probe.h = probeH.value;
    probe.v = probeV.value;
    if (probeH.value.trim() === '' || probeV.value.trim() === '') {
      probeOut.textContent = '';
      return;
    }
    const h = Number(probeH.value.replace(',', '.'));
    const v = Number(probeV.value.replace(',', '.'));
    if (!Number.isFinite(h) || !Number.isFinite(v)) {
      probeOut.textContent = 'Enter H and V as numbers in degrees.';
      return;
    }
    const x = sample(ds, h, v);
    probeOut.textContent = Number.isFinite(x)
      ? `(H ${fmtDeg(h, 4)}, V ${fmtDeg(v, 4)}) = ${fmtValue(kind, x)}  [${x.toPrecision(7)}, bilinear, full data]`
      : `No data at H ${fmtDeg(h, 4)}, V ${fmtDeg(v, 4)}.`;
  };
  for (const inp of [probeH, probeV]) inp.addEventListener('keydown', (e) => e.key === 'Enter' && runProbe());
  runProbe();

  const at = s.maxAt ? `H ${fmtDeg(s.maxAt.h)}, V ${fmtDeg(s.maxAt.v)}` : '—';
  const summaryRows: HTMLElement[] = [...row('Kind', KIND_LABEL[kind])];
  if (kind === 'intensity') {
    summaryRows.push(...row('Max intensity', fmtValue(kind, s.maxIntensity)), ...row('at', at), ...row('Flux in coverage', fmtLm(s.flux)));
  } else if (kind === 'difference') {
    summaryRows.push(
      ...row('Largest value', fmtValue(kind, range.max)),
      ...row('at', at),
      ...row('Smallest value', fmtValue(kind, range.min)),
      ...row('Signed flux', fmtLm(s.flux).replace(' lm', ' lm (signed)')),
    );
  } else if (kind === 'ratio') {
    summaryRows.push(...row('Largest ratio', fmtValue(kind, range.max)), ...row('at', at), ...row('Smallest ratio', fmtValue(kind, range.min)));
  }
  summaryRows.push(
    ...row('H range', `${fmtDeg(s.range.hMin)} to ${fmtDeg(s.range.hMax)}`),
    ...row('V range', `${fmtDeg(s.range.vMin)} to ${fmtDeg(s.range.vMax)}`),
    ...row('Grid step', `H ${fmtStep(s.step.h)}, V ${fmtStep(s.step.v)}`),
  );
  if (ds.meta.sourceFormat !== 'derived') {
    summaryRows.push(
      ...row('Source format', ds.meta.sourceFormat),
      ...row('Photometric type', `Type ${ds.meta.sourceType}${conv ? ` (converted to Type A at ${conv.targetStep}° steps)` : ''}`),
      ...row('Symmetry', symmetry ?? 'none (full data in file)'),
      ...row('Rated lumens', ds.meta.lumens === null ? 'absolute photometry' : fmtLm(ds.meta.lumens)),
    );
  }

  root.replaceChildren(
    ...[
      heading,
      isFile ? el('label', { class: 'check' }, [flip, ' Mirror left/right (flipH) — reloads the file mirrored']) : null,
      el('h3', { text: 'Summary' }),
      el('dl', { class: 'kv' }, summaryRows),
      el('h3', { text: 'Probe' }),
      el('div', { class: 'probe-row' }, [probeH, probeV, el('button', { class: 'btn', text: 'Probe', on: { click: runProbe } })]),
      probeOut,
      el('h3', { text: 'Export' }),
      el('div', { class: 'btn-row' }, [exportIesBtn, exportCsvBtn]),
      exportMsg,
      el('h3', { text: 'Provenance' }),
      el('pre', { class: 'chain', text: provenanceChain(ds) }),
      el('h3', { text: `Warnings (${warnings.length})` }),
      warnings.length
        ? el('ul', { class: 'warnings' }, warnings.map((w) => el('li', { class: w.severity === 'warning' ? 'w-warn' : 'w-info' }, [el('code', { text: w.code }), el('span', { text: ` ${w.message}` })])))
        : el('p', { class: 'muted', text: 'No warnings.' }),
      el('h3', { text: `Keywords (${ds.meta.keywords.length})` }),
      ds.meta.keywords.length ? el('dl', { class: 'kv keywords' }, ds.meta.keywords.flatMap((k) => row(k.key, k.value))) : el('p', { class: 'muted', text: 'No keywords.' }),
    ].filter((n): n is NonNullable<typeof n> => n !== null),
  );
}
