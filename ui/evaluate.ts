import { busy } from './busy';
import { messageText, toUserMessage } from '../core/messages';
import type { AppState, Store } from './state/store';
import type { PhotometricDataset } from '../core/model/dataset';
import { AIM_MODES, parseRegulation, type AimMode, type Regulation } from '../core/regs/schema';
import { evaluateWithAim, type AimedEvaluation } from '../core/regs/reaim';
import { resultsToCsv, type ElementResult, type RegulationResult } from '../core/regs/engine';
import { effective } from './cutoff';
import { el } from './dom';
import { downloadText } from './download';
import { baseName, fmtCd, fmtDegFixed, fmtPct as pct, fmtSig, fmtStatus } from './format';

// ── Regulation files ──────────────────────────────────────────────────────

export interface RegEntry {
  key: string;
  reg: Regulation;
  origin: string;
}

const bundled = import.meta.glob<unknown>('../data/regulations/*.json', { import: 'default', eager: true });
const invalid: Array<{ origin: string; problems: string[] }> = [];
const BUNDLED: RegEntry[] = [];
for (const [file, obj] of Object.entries(bundled)) {
  const origin = file.replace('../', '');
  try {
    const reg = parseRegulation(obj);
    BUNDLED.push({ key: `data:${reg.id}`, reg, origin });
  } catch (e) {
    const m = toUserMessage(e);
    invalid.push({ origin, problems: m.problems.length ? m.problems : [messageText(m)] });
  }
}
/** Regulation files loaded with the file picker in this session (memory only). */
const loaded: RegEntry[] = [];
let loadMessage = '';

export function regulations(): RegEntry[] {
  return [...BUNDLED, ...loaded];
}

async function loadRegulationFile(file: File): Promise<RegEntry | null> {
  try {
    const reg = parseRegulation(JSON.parse(await file.text()));
    const entry = { key: `file:${file.name}:${reg.id}`, reg, origin: `loaded from ${file.name} (this session only)` };
    const i = loaded.findIndex((r) => r.key === entry.key);
    if (i >= 0) loaded.splice(i, 1, entry);
    else loaded.push(entry);
    loadMessage = '';
    return entry;
  } catch (e) {
    loadMessage = `${file.name}: ${messageText(toUserMessage(e))}`;
    return null;
  }
}

// ── Last run (memory only) ────────────────────────────────────────────────

interface Run {
  key: string;
  input: PhotometricDataset;
  value: AimedEvaluation;
}
let run: Run | null = null;
let runError = '';

function inputDataset(state: AppState): PhotometricDataset | null {
  const d = state.entries.find((e) => e.key === state.selectedKey)?.dataset ?? null;
  return d && d.kind === 'intensity' ? d : null;
}

function runKey(state: AppState, input: PhotometricDataset): string {
  const s = state.evaluate;
  const c = effective(state.cutoff);
  return JSON.stringify([s.regId, s.traffic, s.aimMode, s.scaleFactor, s.lamps, input.id, input.name, c.scanH, c.vMin, c.vMax, c.traffic, c.step]);
}

/** The evaluation that belongs to what the viewer shows now, if any. */
export function currentEvaluation(state: AppState): AimedEvaluation | null {
  const input = inputDataset(state);
  if (!run || !input || run.input !== input || run.key !== runKey(state, input)) return null;
  const shown = state.preview?.dataset ?? input;
  return run.value.dataset === shown ? run.value : null;
}

// ── Panel ─────────────────────────────────────────────────────────────────

export const MODE_LABEL: Record<AimMode, string> = {
  'as-loaded': 'As loaded',
  'aim-to-cutoff': 'Aim to cut-off first',
  're-aim-search': 'Re-aim search (best worst-margin)',
};

const fmtMeasured = (e: ElementResult, x: number | null) => (x === null || !Number.isFinite(x) ? '—' : e.type === 'ratio' ? fmtSig(x, 4) : `${fmtCd(x)} cd`);
const fmtPct = (x: number | null) => pct(x, 2, true);
const worstText = (r: RegulationResult) => {
  const w = r.elements.find((e) => e.name === r.worst);
  return w ? `${w.name} (${fmtPct(w.marginPercent)})` : '—';
};

function numberField(label: string, value: number, onChange: (v: number) => void, attrs: Record<string, string> = {}): HTMLElement {
  const i = el('input', { attrs: { type: 'text', inputmode: 'decimal', 'aria-label': label, ...attrs } });
  i.value = String(value);
  i.addEventListener('change', () => {
    const x = Number(i.value.replace(',', '.'));
    if (Number.isFinite(x)) onChange(x);
    else i.value = String(value);
  });
  return el('label', { class: 'field' }, [el('span', { text: label }), i]);
}

export function renderEvaluate(root: HTMLElement, state: AppState, store: Store): void {
  const s = state.evaluate;
  const regs = regulations();
  const input = inputDataset(state);

  const picker = el('input', { attrs: { type: 'file', accept: '.json,application/json', 'aria-label': 'Load a regulation JSON file' } });
  picker.addEventListener('change', async () => {
    const f = picker.files?.[0];
    if (!f) return;
    const entry = await loadRegulationFile(f);
    store.setEvaluate(entry ? { regId: entry.key, selected: null } : {});
  });
  const loadRow = el('div', { class: 'field' }, [
    el('span', { text: 'Load a regulation file (JSON, kept in memory for this session)' }),
    picker,
    loadMessage ? el('pre', { class: 'export-msg chain', text: loadMessage }) : null,
  ].filter((n): n is NonNullable<typeof n> => n !== null));

  const invalidList = invalid.length
    ? el('ul', { class: 'warnings' }, invalid.map((x) => el('li', { class: 'w-warn', text: `${x.origin} is invalid: ${x.problems.join('; ')}` })))
    : null;

  if (!regs.length) {
    root.replaceChildren(
      ...[
        el('p', { class: 'muted', text: 'No regulation files yet. data/regulations/ is empty: regulation values are only added from verified official text.' }),
        invalidList,
        loadRow,
      ].filter((n): n is NonNullable<typeof n> => n !== null),
    );
    return;
  }

  const entry = regs.find((r) => r.key === s.regId) ?? null;
  const regSelect = el('select', { attrs: { 'aria-label': 'Regulation' } }, [
    el('option', { text: 'Choose a regulation…', attrs: { value: '' } }),
    ...regs.map((r) => el('option', { text: `${r.reg.title}${r.reg.verified ? '' : ' [unverified]'}`, attrs: { value: r.key } })),
  ]);
  regSelect.value = entry?.key ?? '';
  regSelect.addEventListener('change', () => store.setEvaluate({ regId: regSelect.value || null, selected: null }));

  const parts: Array<HTMLElement | null> = [el('label', { class: 'field' }, [el('span', { text: 'Regulation' }), regSelect]), invalidList, loadRow];
  if (!entry) {
    root.replaceChildren(...parts.filter((n): n is HTMLElement => n !== null));
    return;
  }
  const reg = entry.reg;

  parts.push(
    reg.verified
      ? null
      : el('p', {
          class: 'banner-unverified',
          attrs: { role: 'alert' },
          text: 'Unverified limits: this file has "verified": false. Results are not a compliance statement until every value has been checked against the official text.',
        }),
    el('p', { class: 'muted small', text: `${reg.source ?? 'Source not given'}${reg.revision ? `, ${reg.revision}` : ''}. Units: ${reg.units}. ${reg.elements.length} elements. ${entry.origin}.` }),
  );

  // Inputs
  const traffic = el('select', { attrs: { 'aria-label': 'Traffic side' } }, [
    el('option', { text: 'Right-hand traffic (as written)', attrs: { value: 'RHT' } }),
    el('option', { text: reg.mirrorForLeftHandTraffic ? 'Left-hand traffic (mirrored in H)' : 'Left-hand traffic (not allowed by this file)', attrs: { value: 'LHT' } }),
  ]);
  (traffic.options[1] as HTMLOptionElement).disabled = !reg.mirrorForLeftHandTraffic;
  traffic.value = s.traffic === 'LHT' && reg.mirrorForLeftHandTraffic ? 'LHT' : 'RHT';
  traffic.addEventListener('change', () => store.setEvaluate({ traffic: traffic.value as 'RHT' | 'LHT' }));

  const modeReason = (m: AimMode): string | null => {
    if (!reg.aim.modes.includes(m)) return 'not allowed by this file';
    if (m === 'aim-to-cutoff' && reg.aim.nominalCutoffV === null) return 'no nominal cut-off V in the file';
    return null;
  };
  const mode = el('select', { attrs: { 'aria-label': 'Aim mode' } }, AIM_MODES.map((m) => el('option', { text: MODE_LABEL[m] + (modeReason(m) ? ` (${modeReason(m)})` : ''), attrs: { value: m } })));
  AIM_MODES.forEach((m, i) => ((mode.options[i] as HTMLOptionElement).disabled = modeReason(m) !== null));
  const usableMode = modeReason(s.aimMode) === null ? s.aimMode : (AIM_MODES.find((m) => modeReason(m) === null) ?? 'as-loaded');
  mode.value = usableMode;
  mode.addEventListener('change', () => store.setEvaluate({ aimMode: mode.value as AimMode }));

  const c = effective(state.cutoff);
  const evaluateBtn = el('button', {
    class: 'btn primary',
    text: 'Evaluate',
    on: {
      click: () => void busy('Evaluating', () => {
        if (!input) return;
        runError = '';
        try {
          const value = evaluateWithAim(input, reg, {
            mode: usableMode,
            traffic: traffic.value as 'RHT' | 'LHT',
            scaleFactor: s.scaleFactor,
            lamps: s.lamps,
            cutoff: { scanH: c.scanH, vMin: c.vMin, vMax: c.vMax, traffic: c.traffic, step: c.step },
          });
          run = { key: runKey({ ...state, evaluate: { ...s, aimMode: usableMode } }, input), input, value };
          if (value.dataset !== input) store.setPreview(value.dataset, { compareTo: input });
          else store.setPreview(null);
          store.setEvaluate({ aimMode: usableMode, selected: null });
        } catch (e) {
          run = null;
          runError = messageText(toUserMessage(e));
          store.setEvaluate({});
        }
      }),
    },
  });
  evaluateBtn.disabled = !input;

  parts.push(
    el('div', { class: 'field-row' }, [
      el('label', { class: 'field' }, [el('span', { text: 'Traffic side' }), traffic]),
      el('label', { class: 'field' }, [el('span', { text: 'Aim mode' }), mode]),
    ]),
    usableMode === 'aim-to-cutoff' || (usableMode === 're-aim-search' && reg.aim.nominalCutoffV !== null)
      ? el('p', { class: 'muted small', text: `Aims to the nominal cut-off V ${reg.aim.nominalCutoffV}° using the Cut-off tab's scan settings (H ${c.scanH}°, V ${c.vMin}..${c.vMax}°).` })
      : null,
    el('div', { class: 'field-row' }, [
      numberField('Scale factor', s.scaleFactor, (v) => store.setEvaluate({ scaleFactor: v })),
      numberField('Number of lamps', s.lamps, (v) => store.setEvaluate({ lamps: v })),
    ]),
    el('div', { class: 'btn-row' }, [evaluateBtn]),
    input ? null : el('p', { class: 'muted', text: 'Select an intensity dataset in the workspace.' }),
    runError ? el('p', { class: 'export-msg', attrs: { role: 'alert' }, text: runError }) : null,
  );

  const ev = currentEvaluation(state);
  if (!ev) {
    if (run && input) parts.push(el('p', { class: 'muted small', text: 'Settings or dataset changed: press Evaluate to update the results.' }));
    root.replaceChildren(...parts.filter((n): n is HTMLElement => n !== null));
    return;
  }

  // Verdict
  const r = ev.result;
  const cond = r.conditions;
  parts.push(
    el('div', { class: `verdict verdict-${r.overall}` }, [
      el('strong', { text: fmtStatus(r.overall).toUpperCase() }),
      el('span', { text: ` ${r.counts.pass} pass, ${r.counts.fail} fail, ${r.counts.notEvaluated} not evaluated. Worst margin: ${worstText(r)}.` }),
    ]),
    el('dl', { class: 'kv small' }, [
      el('dt', { text: 'Aim used' }),
      el('dd', { text: `${MODE_LABEL[ev.mode]}: yaw ${fmtDegFixed(ev.aim.yaw)}, pitch ${fmtDegFixed(ev.aim.pitch)} (relative to the dataset as loaded)` }),
      el('dt', { text: 'Conditions' }),
      el('dd', { text: `scale ${cond.scaleFactor} × ${cond.lamps} lamp(s) = ${cond.factor}; ${cond.traffic}${cond.mirrored ? ' (elements mirrored in H)' : ''}; file units ${cond.units}` }),
      ...(ev.optimised
        ? [
            el('dt', { text: 'Nominal aim' }),
            el('dd', { text: `${ev.nominal.overall.toUpperCase()}, worst ${worstText(ev.nominal)} (yaw ${fmtDegFixed(ev.nominalAim.yaw)}, pitch ${fmtDegFixed(ev.nominalAim.pitch)})` }),
            el('dt', { text: 'Optimised aim' }),
            el('dd', { text: `${ev.optimised.overall.toUpperCase()}, worst ${worstText(ev.optimised)}` }),
          ]
        : []),
    ]),
    ev.notes.length ? el('ul', { class: 'warnings' }, ev.notes.map((n) => el('li', { class: 'w-info', text: n }))) : null,
  );

  // Results table
  const rows = [...r.elements];
  if (s.sortByMargin) rows.sort((a, b) => (a.marginPercent ?? Infinity) - (b.marginPercent ?? Infinity));
  const sortBtn = el('button', {
    class: 'linklike',
    text: `Margin %${s.sortByMargin ? ' ▲' : ''}`,
    title: s.sortByMargin ? 'Back to file order' : 'Sort by margin (worst first)',
    on: { click: () => store.setEvaluate({ sortByMargin: !s.sortByMargin }) },
  });
  const table = el('table', { class: 'cut-table eval-table' }, [
    el('thead', {}, [
      el('tr', {}, [
        el('th', { text: 'Element' }),
        el('th', { text: 'Measured' }),
        el('th', { text: 'Limit' }),
        el('th', { text: 'Margin' }),
        el('th', {}, [sortBtn]),
        el('th', { text: 'Status' }),
      ]),
    ]),
    el(
      'tbody',
      {},
      rows.map((e) => {
        const cls = [e.name === r.worst ? 'worst' : '', e.name === s.selected ? 'selected' : ''].filter(Boolean).join(' ');
        const tr = el('tr', { class: cls, attrs: { tabindex: '0' }, title: [e.ref ? `Source: ${e.ref}` : '', e.reason ?? ''].filter(Boolean).join(' — ') }, [
          el('th', { text: e.name }),
          el('td', { text: fmtMeasured(e, e.measured) }),
          el('td', { text: e.limit ? `${e.limit.kind} ${fmtMeasured(e, e.limit.value)}` : '—' }),
          el('td', { text: e.margin === null ? '—' : fmtMeasured(e, e.margin) }),
          el('td', { text: fmtPct(e.marginPercent) }),
          el('td', { class: `st st-${e.status}`, text: fmtStatus(e.status) }),
        ]);
        const pick = () => store.setEvaluate({ selected: e.name === s.selected ? null : e.name });
        tr.addEventListener('click', pick);
        tr.addEventListener('keydown', (k) => (k.key === 'Enter' || k.key === ' ') && pick());
        return tr;
      }),
    ),
  ]);
  const sel = r.elements.find((e) => e.name === s.selected);
  parts.push(
    el('h3', { text: 'Results' }),
    table,
    sel ? el('p', { class: 'small', text: `${sel.name}: ${sel.ref ? `source ${sel.ref}. ` : ''}${sel.at ? `Worst value at H ${sel.at.h}°, V ${sel.at.v}°. ` : ''}${sel.reason ?? ''}` }) : null,
    el('div', { class: 'btn-row' }, [
      el('button', {
        class: 'btn',
        text: 'Export results CSV',
        on: { click: () => downloadText(`${baseName(input!.name)}-${reg.id}-results.csv`.replace(/[^\w.-]+/g, '_'), resultsToCsv(r), 'text/csv') },
      }),
    ]),
  );
  root.replaceChildren(...parts.filter((n): n is HTMLElement => n !== null));
}
