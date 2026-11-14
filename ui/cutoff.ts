import Plotly from './plotly';
import type { AppState, CutoffSettings, Store } from './state/store';
import type { PhotometricDataset } from '../core/model/dataset';
import {
  evaluateSharpness,
  parseCutoffPreset,
  scanCutoff,
  traceCutoff,
  type CutoffPreset,
  type ScanResult,
  type SharpnessResult,
  type TraceResult,
} from '../core/analysis/cutoff';
import { aimToCutoff, AimError, cutoffVFromPercentDown, percentDownFromV } from '../core/ops/aim';
import { el } from './dom';
import { fmtDeg } from './format';

// ── Presets (data/presets/cutoff/*.json, schema excluded) ────────────────
const presetFiles = import.meta.glob<unknown>('../data/presets/cutoff/*.json', { import: 'default', eager: true });
export const PRESETS: CutoffPreset[] = Object.entries(presetFiles)
  .filter(([f]) => !f.endsWith('schema.json'))
  .map(([, obj]) => parseCutoffPreset(obj))
  .sort((a, b) => a.title.localeCompare(b.title));

export interface EffectiveSettings {
  scanH: number;
  vMin: number;
  vMax: number;
  step: number;
  traffic: 'RHT' | 'LHT';
  hMin: number;
  hMax: number;
  hStep: number;
  preset: CutoffPreset | null;
  /** Which fields came from the preset. */
  fromPreset: string[];
}

/** The settings actually used: preset values where they are not null, otherwise the tab's fields. */
export function effective(s: CutoffSettings): EffectiveSettings {
  const preset = PRESETS.find((p) => p.id === s.presetId) ?? null;
  const fromPreset: string[] = [];
  const pick = <T,>(name: string, presetValue: T | null | undefined, own: T): T => {
    if (presetValue !== null && presetValue !== undefined) {
      fromPreset.push(name);
      return presetValue;
    }
    return own;
  };
  return {
    scanH: pick('scan H', preset?.scanH, s.scanH),
    vMin: pick('V min', preset?.vWindow.min, s.vMin),
    vMax: pick('V max', preset?.vWindow.max, s.vMax),
    step: s.step,
    traffic: pick('traffic side', preset?.trafficSide, s.traffic),
    hMin: s.hMin,
    hMax: s.hMax,
    hStep: s.hStep,
    preset,
    fromPreset,
  };
}

export interface CutoffAnalysis {
  scan: ScanResult;
  trace: TraceResult;
  sharpness: SharpnessResult;
  settings: EffectiveSettings;
}

// Analyses are cached per dataset object and settings (memory only).
const cache = new WeakMap<PhotometricDataset, Map<string, CutoffAnalysis>>();
export function analyse(ds: PhotometricDataset, s: CutoffSettings): CutoffAnalysis {
  const e = effective(s);
  const key = JSON.stringify({ ...e, preset: e.preset?.id ?? null });
  let per = cache.get(ds);
  if (!per) cache.set(ds, (per = new Map()));
  let a = per.get(key);
  if (!a) {
    const scan = scanCutoff(ds, { h: e.scanH, vMin: e.vMin, vMax: e.vMax, step: e.step });
    const trace = traceCutoff(ds, { hMin: e.hMin, hMax: e.hMax, hStep: e.hStep, vMin: e.vMin, vMax: e.vMax, step: e.step, traffic: e.traffic });
    const sharpness = evaluateSharpness(scan.gMax, e.preset?.sharpness ?? { min: null, max: null });
    a = { scan, trace, sharpness, settings: e };
    per.set(key, a);
  }
  return a;
}

/** The dataset shown (preview or selected) and the one to compare with (preview's original, or the overlay). */
export function cutoffSubjects(state: AppState): { main: PhotometricDataset | null; other: PhotometricDataset | null; otherLabel: string } {
  const entry = state.entries.find((e) => e.key === state.selectedKey);
  const ov = state.entries.find((e) => e.key === state.overlayKey);
  const main = state.preview?.dataset ?? entry?.dataset ?? null;
  const compare = state.preview?.compareTo ?? null;
  const other = compare ?? (ov?.dataset && ov.dataset !== main ? ov.dataset : null);
  const usable = (d: PhotometricDataset | null) => (d && d.kind === 'intensity' ? d : null);
  return { main: usable(main), other: usable(other), otherLabel: compare ? 'before' : 'overlay' };
}

// ── Panel ─────────────────────────────────────────────────────────────────

let aimMessage = '';

function num(v: string, fallback: number): number {
  const x = Number(v.replace(',', '.'));
  return Number.isFinite(x) ? x : fallback;
}

function field(label: string, value: number, onChange: (v: number) => void, locked: boolean): HTMLElement {
  const i = el('input', { attrs: { type: 'text', inputmode: 'decimal', 'aria-label': label } });
  i.value = String(value);
  i.disabled = locked;
  i.title = locked ? 'Set by the selected preset' : '';
  i.addEventListener('change', () => onChange(num(i.value, value)));
  return el('label', { class: 'field' }, [el('span', { text: label + (locked ? ' (preset)' : '') }), i]);
}

function sel<T extends string>(label: string, value: T, options: Array<[T, string]>, onChange: (v: T) => void, locked = false): HTMLElement {
  const s = el('select', { attrs: { 'aria-label': label } }, options.map(([v, t]) => el('option', { text: t, attrs: { value: v } })));
  s.value = value;
  s.disabled = locked;
  s.addEventListener('change', () => onChange(s.value as T));
  return el('label', { class: 'field' }, [el('span', { text: label + (locked ? ' (preset)' : '') }), s]);
}

const fmtG = (g: number) => (Number.isFinite(g) ? g.toFixed(3) : '—');
const fmtPct = (v: number) => (Number.isFinite(v) ? `${percentDownFromV(v).toFixed(2)}% ${percentDownFromV(v) >= 0 ? 'down' : '(up)'}` : '—');

function summaryRows(a: CutoffAnalysis): Array<[string, string]> {
  const s = a.scan;
  const f = a.trace.fit;
  const sharp =
    a.sharpness.status === 'no-limits'
      ? 'values only (no limits in preset)'
      : `${a.sharpness.status.toUpperCase()}${a.sharpness.margin !== null ? `, margin ${a.sharpness.margin >= 0 ? '+' : ''}${a.sharpness.margin.toFixed(3)}` : ''}`;
  return [
    ['Cut-off V', s.found ? fmtDeg(s.v, 3) : 'not found'],
    ['Cut-off (inclination)', s.found ? fmtPct(s.v) : '—'],
    ['Gmax', fmtG(s.gMax)],
    ['Sharpness', s.found ? sharp : '—'],
    ['Native V step', `${fmtDeg(s.nativeStep, 3)}${s.coarse ? '  ⚠ coarser than 0.1°' : ''}`],
    ['Secondary maxima', s.secondary.length ? s.secondary.map((x) => `${fmtDeg(x.v, 2)} (G ${fmtG(x.g)})`).join(', ') : 'none'],
    ['Horizontal part, mean V', f ? fmtDeg(f.horizontal.meanV, 3) : '—'],
    ['Horizontal part, slope', f ? fmtDeg(f.horizontal.slopeDeg, 3) : '—'],
    ['Straightness max / RMS', f ? `${fmtDeg(f.horizontal.maxDev, 3)} / ${fmtDeg(f.horizontal.rmsDev, 3)}` : '—'],
    ['Elbow', f ? `H ${fmtDeg(f.elbow.h, 2)}, V ${fmtDeg(f.elbow.v, 3)}` : '—'],
    ['Shoulder angle', f ? fmtDeg(f.shoulderAngle, 2) : '—'],
    ['Fit residual (RMS)', f ? fmtDeg(f.residualRms, 4) : a.trace.reason ?? '—'],
  ];
}

function warnings(a: CutoffAnalysis): string[] {
  const w: string[] = [];
  if (!a.scan.found) w.push(`No cut-off found at H ${a.settings.scanH}° in V ${a.settings.vMin}..${a.settings.vMax}°.`);
  if (a.scan.coarse) w.push(`The file's V step near the cut-off is ${a.scan.nativeStep}°, coarser than 0.1°: G is an interpolation artefact here, not a measurement.`);
  if (a.scan.secondary.length) w.push(`${a.scan.secondary.length} other gradient maximum(s) at or above 30% of Gmax: check that the right edge was taken as the cut-off.`);
  if (a.trace.poorFit && a.trace.reason) w.push(a.trace.reason);
  return w;
}

function scanFigure(main: CutoffAnalysis, other: CutoffAnalysis | null, otherLabel: string) {
  const cs = getComputedStyle(document.documentElement);
  const fg = cs.getPropertyValue('--fg').trim() || '#1d1d1b';
  const accent = cs.getPropertyValue('--accent').trim() || '#3b528b';
  const grid = cs.getPropertyValue('--grid').trim() || '#e3e3dd';
  const pos = (x: number[]) => x.map((y) => (y > 0 ? y : null));
  const fin = (x: number[]) => x.map((y) => (Number.isFinite(y) ? y : null));
  const data: object[] = [
    { type: 'scatter', mode: 'lines', x: main.scan.curve.v, y: pos(main.scan.curve.i), name: 'I (cd)', line: { color: accent, width: 1.5 }, yaxis: 'y' },
    { type: 'scatter', mode: 'lines', x: main.scan.curve.v, y: fin(main.scan.curve.g), name: 'G', line: { color: '#e8590c', width: 1.5 }, yaxis: 'y2' },
  ];
  if (other) {
    data.push(
      { type: 'scatter', mode: 'lines', x: other.scan.curve.v, y: pos(other.scan.curve.i), name: `I ${otherLabel}`, line: { color: accent, width: 1.2, dash: 'dash' }, yaxis: 'y' },
      { type: 'scatter', mode: 'lines', x: other.scan.curve.v, y: fin(other.scan.curve.g), name: `G ${otherLabel}`, line: { color: '#e8590c', width: 1.2, dash: 'dash' }, yaxis: 'y2' },
    );
  }
  const shapes: object[] = [];
  if (main.scan.found) shapes.push({ type: 'line', xref: 'x', yref: 'paper', x0: main.scan.v, x1: main.scan.v, y0: 0, y1: 1, line: { color: fg, width: 1.5 } });
  if (other?.scan.found) shapes.push({ type: 'line', xref: 'x', yref: 'paper', x0: other.scan.v, x1: other.scan.v, y0: 0, y1: 1, line: { color: fg, width: 1, dash: 'dash' } });
  const lim = main.settings.preset?.sharpness;
  for (const y of [lim?.min, lim?.max]) {
    if (y !== null && y !== undefined) shapes.push({ type: 'line', xref: 'paper', yref: 'y2', x0: 0, x1: 1, y0: y, y1: y, line: { color: '#b42318', width: 1, dash: 'dot' } });
  }
  return {
    data,
    layout: {
      height: 250,
      margin: { l: 50, r: 45, t: 10, b: 40 },
      paper_bgcolor: 'rgba(0,0,0,0)',
      plot_bgcolor: 'rgba(0,0,0,0)',
      font: { color: fg, size: 10 },
      showlegend: true,
      legend: { orientation: 'h', y: -0.25, font: { size: 9 } },
      xaxis: { title: { text: 'V (°)' }, gridcolor: grid },
      yaxis: { title: { text: 'I (cd, log)' }, type: 'log', gridcolor: grid },
      yaxis2: { title: { text: 'G' }, overlaying: 'y', side: 'right', zeroline: true, zerolinecolor: grid, showgrid: false },
      shapes,
    },
  };
}

export function renderCutoff(root: HTMLElement, state: AppState, store: Store): void {
  const { main, other, otherLabel } = cutoffSubjects(state);
  if (!main) {
    root.replaceChildren(el('p', { class: 'muted', text: 'Select an intensity dataset to analyse its cut-off.' }));
    return;
  }
  const s = state.cutoff;
  const e = effective(s);
  const set = (patch: Partial<CutoffSettings>) => {
    aimMessage = '';
    store.setCutoff(patch);
  };
  const locked = (name: string) => e.fromPreset.includes(name);
  const a = analyse(main, s);
  const b = other ? analyse(other, s) : null;

  const presetInfo = e.preset
    ? el('p', { class: 'muted small' }, [
        `${e.preset.source ?? 'Source: not filled in'}${e.preset.revision ? `, ${e.preset.revision}` : ''}. `,
        e.preset.sharpness.min === null && e.preset.sharpness.max === null ? 'No sharpness limits: values only.' : 'Sharpness limits from the preset.',
      ])
    : el('p', { class: 'muted small', text: 'No preset: tool defaults, no limits. Values are reported without pass/fail.' });

  const fields = el('div', { class: 'manipulate' }, [
    sel('Preset', (s.presetId ?? '') as string, [['', 'None (manual settings)'], ...PRESETS.map((p): [string, string] => [p.id, p.title])], (v) => set({ presetId: v || null })),
    presetInfo,
    el('div', { class: 'field-row' }, [
      field('Scan H °', e.scanH, (v) => set({ scanH: v }), locked('scan H')),
      field('Step °', e.step, (v) => set({ step: v > 0 ? v : s.step }), false),
    ]),
    el('div', { class: 'field-row' }, [
      field('V min °', e.vMin, (v) => set({ vMin: v }), locked('V min')),
      field('V max °', e.vMax, (v) => set({ vMax: v }), locked('V max')),
    ]),
    sel('Traffic side', e.traffic, [['RHT', 'Right-hand traffic (shoulder right)'], ['LHT', 'Left-hand traffic (shoulder left)']], (v) =>
      set({ traffic: v, scanH: s.scanH === (v === 'LHT' ? -2 : 2) ? -s.scanH : s.scanH }), locked('traffic side')),
    el('div', { class: 'field-row three' }, [
      field('Trace H min', e.hMin, (v) => set({ hMin: v }), false),
      field('H max', e.hMax, (v) => set({ hMax: v }), false),
      field('H step', e.hStep, (v) => set({ hStep: v > 0 ? v : s.hStep }), false),
    ]),
  ]);

  const plot = el('div', { class: 'scan-plot' });
  const rowsA = summaryRows(a);
  const rowsB = b ? summaryRows(b) : null;
  const table = el('table', { class: 'cut-table' }, [
    el('thead', {}, [el('tr', {}, [el('th', { text: '' }), el('th', { text: rowsB ? 'This dataset' : 'Value' }), rowsB ? el('th', { text: otherLabel === 'before' ? 'Before' : 'Overlay' }) : null].filter((x): x is HTMLTableCellElement => x !== null))]),
    el('tbody', {}, rowsA.map(([k, v], i) => el('tr', {}, [el('th', { text: k }), el('td', { text: v }), rowsB ? el('td', { text: rowsB[i]![1] }) : null].filter((x): x is HTMLTableCellElement => x !== null)))),
  ]);
  const warn = warnings(a);

  // Aim to cut-off
  const target = el('input', { attrs: { type: 'text', inputmode: 'decimal', 'aria-label': 'Aim target' } });
  target.value = String(s.targetValue);
  target.addEventListener('change', () => set({ targetValue: num(target.value, s.targetValue) }));
  const targetV = s.targetUnit === 'percent' ? cutoffVFromPercentDown(s.targetValue) : s.targetValue;
  const elbow = el('input', { attrs: { type: 'checkbox' } });
  elbow.checked = s.elbowAtZero;
  elbow.addEventListener('change', () => set({ elbowAtZero: elbow.checked }));
  const aimBtn = el('button', {
    class: 'btn primary',
    text: 'Preview aim',
    on: {
      click: () => {
        const source = state.preview?.compareTo ?? main;
        try {
          const r = aimToCutoff(source, {
            targetV, scanH: e.scanH, vMin: e.vMin, vMax: e.vMax, step: e.step, traffic: e.traffic,
            elbowAtZero: s.elbowAtZero, trace: { hMin: e.hMin, hMax: e.hMax, hStep: e.hStep },
          });
          aimMessage =
            `Correction: yaw ${r.yaw.toFixed(3)}°, pitch ${r.pitch.toFixed(3)}° in ${r.steps} step(s); ` +
            `${r.converged ? 'converged' : 'NOT converged'}; residual V ${r.residual.v.toFixed(4)}°` +
            (r.residual.h !== null ? `, elbow H ${r.residual.h.toFixed(3)}°` : '') +
            '. Use “Create dataset” in the preview bar to keep it.';
          store.setPreview(r.dataset, { compareTo: source });
        } catch (err) {
          aimMessage = err instanceof AimError ? err.message : String(err);
          store.setCutoff({});
        }
      },
    },
  });

  root.replaceChildren(
    ...[
      fields,
      el('h3', { text: `Scan at H ${fmtDeg(e.scanH)}` }),
      plot,
      warn.length ? el('ul', { class: 'warnings' }, warn.map((w) => el('li', { class: 'w-warn', text: w }))) : null,
      el('h3', { text: 'Summary' }),
      table,
      el('h3', { text: 'Aim to cut-off' }),
      el('div', { class: 'field-row' }, [
        el('label', { class: 'field' }, [el('span', { text: 'Target' }), target]),
        sel('Unit', s.targetUnit, [['percent', '% down'], ['deg', 'degrees (V)']], (v) => set({ targetUnit: v })),
      ]),
      el('p', { class: 'muted small', text: `Target cut-off V = ${fmtDeg(targetV, 4)} at H ${fmtDeg(e.scanH)}.` }),
      el('label', { class: 'check' }, [elbow, ' Also put the elbow at H = 0 (yaw)']),
      el('div', { class: 'btn-row' }, [aimBtn]),
      aimMessage ? el('p', { class: 'summary-text', attrs: { role: 'status' }, text: aimMessage }) : null,
    ].filter((n): n is NonNullable<typeof n> => n !== null),
  );
  const fig = scanFigure(a, b, otherLabel);
  void Plotly.react(plot, fig.data, fig.layout, { responsive: true, displaylogo: false, modeBarButtonsToRemove: ['select2d', 'lasso2d'] });
}
