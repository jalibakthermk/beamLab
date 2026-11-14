import type { AppState, Store } from './state/store';
import { el } from './dom';
import { baseName, fmtCd, fmtDeg, fmtLm, fmtStep } from './format';
import { downloadText } from './download';
import { exportIes, ExportError } from '../core/io/export';
import { exportCsv } from '../core/io/csv';
import { sample } from '../core/geometry/interpolate';

// Probe inputs survive re-renders of the panel (kept in memory only).
const probe = { h: '', v: '' };

const TABS = ['Info', 'Evaluate', 'Road', 'Manipulate', 'Cut-off'];

function row(label: string, value: string | Node): HTMLElement[] {
  return [el('dt', { text: label }), el('dd', {}, [value])];
}

export function renderInfo(root: HTMLElement, state: AppState, store: Store): void {
  const tabs = el(
    'div',
    { class: 'tabs', attrs: { role: 'tablist' } },
    TABS.map((t, i) => {
      const b = el('button', {
        class: i === 0 ? 'tab active' : 'tab',
        text: t,
        attrs: { role: 'tab', 'aria-selected': String(i === 0) },
        title: i === 0 ? '' : 'Coming in a later phase',
      });
      b.disabled = i !== 0;
      return b;
    }),
  );

  const entry = state.entries.find((e) => e.key === state.selectedKey);
  if (!entry?.dataset || !entry.summary) {
    root.replaceChildren(tabs, el('p', { class: 'muted pad', text: 'Load and select a dataset to see its details.' }));
    return;
  }
  const ds = entry.dataset;
  const s = entry.summary;
  const conv = ds.provenance?.params['conversion'] as { from: string; targetStep: number } | null | undefined;
  const symmetry = ds.provenance?.params['symmetry'] as string | null | undefined;

  const flip = el('input', {
    attrs: { type: 'checkbox' },
    on: { change: (ev) => store.setFlipH(entry.key, (ev.target as HTMLInputElement).checked) },
  });
  flip.checked = entry.flipH;

  const exportMsg = el('p', { class: 'export-msg', attrs: { role: 'status' } });
  const name = baseName(entry.name) + (entry.flipH ? '-mirrored' : '');
  const exportIesBtn = el('button', {
    class: 'btn',
    text: 'Export IES',
    on: {
      click: () => {
        try {
          downloadText(`${name}-beamLab.ies`, exportIes(ds), 'text/plain');
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
    on: { click: () => downloadText(`${name}-beamLab.csv`, exportCsv(ds), 'text/csv') },
  });

  const warnings = entry.warnings.length
    ? el(
        'ul',
        { class: 'warnings' },
        entry.warnings.map((w) =>
          el('li', { class: w.severity === 'warning' ? 'w-warn' : 'w-info' }, [
            el('code', { text: w.code }),
            el('span', { text: ` ${w.message}` }),
          ]),
        ),
      )
    : el('p', { class: 'muted', text: 'No warnings.' });

  const keywords = ds.meta.keywords.length
    ? el(
        'dl',
        { class: 'kv keywords' },
        ds.meta.keywords.flatMap((k) => row(k.key, k.value)),
      )
    : el('p', { class: 'muted', text: 'No keywords.' });

  const probeH = el('input', { class: 'probe-input', attrs: { type: 'text', inputmode: 'decimal', 'aria-label': 'Probe H in degrees', placeholder: 'H °' } });
  const probeV = el('input', { class: 'probe-input', attrs: { type: 'text', inputmode: 'decimal', 'aria-label': 'Probe V in degrees', placeholder: 'V °' } });
  probeH.value = probe.h;
  probeV.value = probe.v;
  const probeOut = el('p', { class: 'probe-out', attrs: { role: 'status' } });
  const runProbe = () => {
    probe.h = probeH.value;
    probe.v = probeV.value;
    const h = Number(probeH.value.replace(',', '.'));
    const v = Number(probeV.value.replace(',', '.'));
    if (probeH.value.trim() === '' || probeV.value.trim() === '') {
      probeOut.textContent = '';
      return;
    }
    if (!Number.isFinite(h) || !Number.isFinite(v)) {
      probeOut.textContent = 'Enter H and V as numbers in degrees.';
      return;
    }
    const i = sample(ds, h, v);
    probeOut.textContent = Number.isFinite(i)
      ? `I(H ${fmtDeg(h, 4)}, V ${fmtDeg(v, 4)}) = ${i.toPrecision(7)} cd (bilinear, full data)`
      : `No data at H ${fmtDeg(h, 4)}, V ${fmtDeg(v, 4)}.`;
  };
  for (const inp of [probeH, probeV]) inp.addEventListener('keydown', (e) => e.key === 'Enter' && runProbe());
  const probeBtn = el('button', { class: 'btn', text: 'Probe', on: { click: runProbe } });
  runProbe();

  root.replaceChildren(
    tabs,
    el('div', { class: 'pad' }, [
      el('h2', { text: entry.name, class: 'break' }),
      el('label', { class: 'check' }, [flip, ' Mirror left/right (flipH) — reloads the file mirrored']),
      el('h3', { text: 'Summary' }),
      el('dl', { class: 'kv' }, [
        ...row('Max intensity', `${fmtCd(s.maxIntensity)} cd`),
        ...row('at', s.maxAt ? `H ${fmtDeg(s.maxAt.h)}, V ${fmtDeg(s.maxAt.v)}` : '—'),
        ...row('Flux in coverage', fmtLm(s.flux)),
        ...row('H range', `${fmtDeg(s.range.hMin)} to ${fmtDeg(s.range.hMax)}`),
        ...row('V range', `${fmtDeg(s.range.vMin)} to ${fmtDeg(s.range.vMax)}`),
        ...row('Grid step', `H ${fmtStep(s.step.h)}, V ${fmtStep(s.step.v)}`),
        ...row('Source format', ds.meta.sourceFormat),
        ...row(
          'Photometric type',
          `Type ${ds.meta.sourceType}${conv ? ` (converted to Type A at ${conv.targetStep}° steps)` : ''}`,
        ),
        ...row('Symmetry', symmetry ?? 'none (full data in file)'),
        ...row('Rated lumens', ds.meta.lumens === null ? 'absolute photometry' : fmtLm(ds.meta.lumens)),
      ]),
      el('h3', { text: 'Probe' }),
      el('div', { class: 'probe-row' }, [probeH, probeV, probeBtn]),
      probeOut,
      el('h3', { text: 'Export' }),
      el('div', { class: 'btn-row' }, [exportIesBtn, exportCsvBtn]),
      exportMsg,
      el('h3', { text: `Warnings (${entry.warnings.length})` }),
      warnings,
      el('h3', { text: `Keywords (${ds.meta.keywords.length})` }),
      keywords,
    ]),
  );
}
