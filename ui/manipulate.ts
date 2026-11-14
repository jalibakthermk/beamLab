import type { AppState, Entry, Store } from './state/store';
import type { PhotometricDataset } from '../core/model/dataset';
import {
  add,
  clampToIntensity,
  defaultFloor,
  divide,
  multiply,
  negativeCount,
  OperationError,
  planBinary,
  scale,
  subtract,
  windowMask,
  type BinaryOp,
} from '../core/ops/arithmetic';
import { pitchFromPercent, planRotation, rotate, type RotationReport, type RotationTarget } from '../core/geometry/rotate';
import { el } from './dom';
import { fmtCd, fmtDeg, fmtLm, fmtValue, type Kind } from './format';

type Op = BinaryOp | 'scale' | 'clamp' | 'window' | 'rotate';

/** Above this share of target nodes outside the source coverage, the report shows a warning. */
const OUTSIDE_WARNING = 0.05;

const OPS: Array<{ value: Op; label: string }> = [
  { value: 'add', label: 'Add: a·A + b·B' },
  { value: 'subtract', label: 'Subtract: A − B' },
  { value: 'scale', label: 'Scale: A × k' },
  { value: 'multiply', label: 'Multiply: A × B (B ratio or mask)' },
  { value: 'divide', label: 'Divide: A / B (ratio map)' },
  { value: 'clamp', label: 'Clamp negatives to zero (difference → intensity)' },
  { value: 'window', label: 'Window mask (1 inside, 0 outside)' },
  { value: 'rotate', label: 'Rotate / aim (yaw, pitch, roll)' },
];

const BINARY: Op[] = ['add', 'subtract', 'multiply', 'divide'];

// Form state survives re-renders (memory only).
const form = {
  op: 'add' as Op,
  a: '',
  b: '',
  wa: '1',
  wb: '1',
  k: '1',
  extent: 'intersection' as 'intersection' | 'union',
  zeroA: false,
  zeroB: false,
  floor: '',
  hMin: '-10',
  hMax: '10',
  vMin: '-5',
  vMax: '5',
  yaw: '0',
  pitch: '0',
  pitchUnit: 'deg' as 'deg' | 'percent',
  roll: '0',
  rtarget: 'same' as RotationTarget,
  name: '',
  message: '',
};

function aimFromForm() {
  const p = num(form.pitch);
  return { yaw: num(form.yaw), pitch: form.pitchUnit === 'percent' ? pitchFromPercent(p) : p, roll: num(form.roll) };
}

const num = (s: string) => Number(s.replace(',', '.'));

interface RunResult {
  dataset: PhotometricDataset;
  report?: RotationReport;
  compareTo?: PhotometricDataset;
}

function run(a: PhotometricDataset | undefined, b: PhotometricDataset | undefined): RunResult {
  if (form.op === 'rotate') {
    if (!a) throw new OperationError('KIND', 'Choose input A.');
    const name = form.name.trim();
    const r = rotate(a, aimFromForm(), { target: form.rtarget, ...(name ? { name } : {}) });
    return { dataset: r.dataset, report: r.report, compareTo: a };
  }
  return { dataset: runOp(a, b) };
}

function runOp(a: PhotometricDataset | undefined, b: PhotometricDataset | undefined): PhotometricDataset {
  if (!a) throw new OperationError('KIND', 'Choose input A.');
  const name = form.name.trim() || undefined;
  const common = { ...(name ? { name } : {}) };
  const binOpts = { ...common, extent: form.extent, zeroOutside: { a: form.zeroA, b: form.zeroB } };
  switch (form.op) {
    case 'scale':
      return scale(a, num(form.k), common);
    case 'clamp':
      return clampToIntensity(a, common);
    case 'rotate':
      throw new Error('unreachable');
    case 'window':
      return windowMask(a.grid, { hMin: num(form.hMin), hMax: num(form.hMax), vMin: num(form.vMin), vMax: num(form.vMax) }, { ...common, gridFrom: { id: a.id, name: a.name } });
  }
  if (!b) throw new OperationError('KIND', 'Choose input B.');
  switch (form.op) {
    case 'add':
      return add(a, b, { ...binOpts, weights: [num(form.wa), num(form.wb)] });
    case 'subtract':
      return subtract(a, b, binOpts);
    case 'multiply':
      return multiply(a, b, binOpts);
    case 'divide':
      return divide(a, b, { ...binOpts, ...(form.floor.trim() ? { floor: num(form.floor) } : {}) });
  }
}

/** Plain-language description of what will happen, shown before running. */
function summary(a: PhotometricDataset | undefined, b: PhotometricDataset | undefined): { text: string; ok: boolean } {
  if (!a) return { text: 'Choose input A.', ok: false };
  const g = (d: PhotometricDataset) => `${d.grid.h.length} × ${d.grid.v.length}`;
  switch (form.op) {
    case 'scale': {
      const k = num(form.k);
      if (!Number.isFinite(k) || k < 0) return { text: 'k must be a number ≥ 0. Negative factors are rejected; use Subtract for differences.', ok: false };
      if (a.kind === 'mask') return { text: 'A mask cannot be scaled.', ok: false };
      return { text: `Multiplies every value of “${a.name}” by ${k}. Same grid (${g(a)} nodes), no resampling. Result: ${a.kind}.`, ok: true };
    }
    case 'clamp': {
      if (a.kind !== 'difference') return { text: `Clamp works on a difference dataset; “${a.name}” is ${a.kind}.`, ok: false };
      return {
        text:
          `Sets the ${negativeCount(a).toLocaleString('en-US')} negative values of “${a.name}” to zero and makes it an intensity dataset, which can be exported as IES. ` +
          'Do this only on purpose: it hides where the first dataset was below the second. The clamp is recorded in provenance.',
        ok: true,
      };
    }
    case 'window': {
      const w = [form.hMin, form.hMax, form.vMin, form.vMax].map(num);
      if (!w.every(Number.isFinite) || w[0]! > w[1]! || w[2]! > w[3]!) return { text: 'Enter H min ≤ H max and V min ≤ V max in degrees.', ok: false };
      return {
        text: `Makes a mask on the grid of “${a.name}” (${g(a)} nodes): 1 inside H ${fmtDeg(w[0]!)} to ${fmtDeg(w[1]!)}, V ${fmtDeg(w[2]!)} to ${fmtDeg(w[3]!)}, 0 outside. Multiply an intensity by it to isolate that region.`,
        ok: true,
      };
    }
  }
  if (form.op === 'rotate') {
    const aim = aimFromForm();
    if (![aim.yaw, aim.pitch, aim.roll].every(Number.isFinite)) return { text: 'Enter yaw, pitch and roll as numbers.', ok: false };
    const pitchText = form.pitchUnit === 'percent' ? `${num(form.pitch)}% = ${aim.pitch.toFixed(4)}°` : `${aim.pitch}°`;
    const plan = planRotation(a, aim);
    const t = plan.total;
    const parts = [
      `Rotates “${a.name}”: roll ${aim.roll}°, then pitch ${pitchText}, then yaw ${aim.yaw}°.`,
      plan.composed
        ? `“${a.name}” is itself a rotation: the rotations are composed (total yaw ${t.yaw.toFixed(3)}°, pitch ${t.pitch.toFixed(3)}°, roll ${t.roll.toFixed(3)}°) and its original “${plan.originalName}” is used directly (no added blur).`
        : '',
      plan.fastPath
        ? 'The total is a pure yaw: an exact shift of the H grid, no resampling, values unchanged.'
        : `True rotation on the sphere, bilinear resampling onto ${form.rtarget === 'same' ? `the same grid (${a.grid.h.length} × ${a.grid.v.length} nodes)` : 'the grid extended to contain the rotated coverage'}.`,
      'Preview to see the report (coverage, flux, peak) before creating the dataset.',
    ];
    return { text: parts.filter(Boolean).join(' '), ok: true };
  }
  if (!b) return { text: 'Choose input B.', ok: false };
  const weights: [number, number] = [num(form.wa), num(form.wb)];
  const plan = planBinary(form.op, a, b, { extent: form.extent, weights });
  if (!plan.ok) return { text: plan.error, ok: false };
  const what =
    form.op === 'add'
      ? `Adds ${weights[0]} × “${a.name}” + ${weights[1]} × “${b.name}”.`
      : form.op === 'subtract'
        ? `Subtracts “${b.name}” from “${a.name}”; negative values are kept.`
        : form.op === 'multiply'
          ? `Multiplies “${a.name}” by the ${b.kind} “${b.name}”.`
          : `Divides “${a.name}” by “${b.name}”. Where “${b.name}” is below ${form.floor.trim() ? `${num(form.floor)} cd` : `${fmtCd(defaultFloor(b))} cd (default: 0.1% of its peak)`}, the result has no data.`;
  const gridText = plan.identical
    ? 'The grids are identical: computed node by node, no resampling.'
    : `The grids differ: both inputs are resampled (bilinear) onto a merged grid that keeps every node of both.`;
  const c = plan.coverage;
  const zero = (z: boolean, n: string) => (z ? `${n} counts as zero` : `${n} gives no data`);
  return {
    text:
      `${what} ${gridText} Result: ${plan.resultKind}, ${plan.gridSize.h} × ${plan.gridSize.v} = ${(plan.gridSize.h * plan.gridSize.v).toLocaleString('en-US')} nodes, ` +
      `over the ${form.extent} of the coverages (H ${fmtDeg(c.hMin)} to ${fmtDeg(c.hMax)}, V ${fmtDeg(c.vMin)} to ${fmtDeg(c.vMax)}). ` +
      `Outside its coverage, ${zero(form.zeroA, 'A')}; ${zero(form.zeroB, 'B')}.`,
    ok: true,
  };
}

function select(label: string, value: string, options: Array<{ value: string; label: string }>, onChange: (v: string) => void): HTMLElement {
  const s = el('select', { attrs: { 'aria-label': label } }, options.map((o) => el('option', { text: o.label, attrs: { value: o.value } })));
  s.value = value;
  s.addEventListener('change', () => onChange(s.value));
  return el('label', { class: 'field' }, [el('span', { text: label }), s]);
}

function textField(label: string, value: string, onChange: (v: string) => void, attrs: Record<string, string> = {}): HTMLElement {
  const i = el('input', { attrs: { type: 'text', inputmode: 'decimal', 'aria-label': label, ...attrs } });
  i.value = value;
  i.addEventListener('change', () => onChange(i.value));
  return el('label', { class: 'field' }, [el('span', { text: label }), i]);
}

function check(label: string, value: boolean, onChange: (v: boolean) => void): HTMLElement {
  const i = el('input', { attrs: { type: 'checkbox' } });
  i.checked = value;
  i.addEventListener('change', () => onChange(i.checked));
  return el('label', { class: 'check' }, [i, ` ${label}`]);
}

export function renderManipulate(root: HTMLElement, state: AppState, store: Store): void {
  const usable = state.entries.filter((e): e is Entry & { dataset: PhotometricDataset } => e.dataset !== null);
  if (!usable.length) {
    root.replaceChildren(el('p', { class: 'muted', text: 'Load at least one dataset to use the operations.' }));
    return;
  }
  const keys = usable.map((e) => e.key);
  if (!keys.includes(form.a)) form.a = state.selectedKey && keys.includes(state.selectedKey) ? state.selectedKey : keys[0]!;
  if (!keys.includes(form.b)) form.b = (state.overlayKey && keys.includes(state.overlayKey) ? state.overlayKey : keys.find((k) => k !== form.a)) ?? keys[0]!;
  const A = usable.find((e) => e.key === form.a)?.dataset;
  const B = usable.find((e) => e.key === form.b)?.dataset;
  const binary = BINARY.includes(form.op);
  const rerender = () => renderManipulate(root, store.getState(), store);
  const set = (patch: Partial<typeof form>) => {
    Object.assign(form, patch, { message: '' });
    rerender();
  };
  const dsOptions = usable.map((e) => ({ value: e.key, label: `${e.name} [${e.dataset.kind}]` }));

  const fields: HTMLElement[] = [
    select('Operation', form.op, OPS, (v) => set({ op: v as Op })),
    select(form.op === 'window' ? 'Grid from' : 'Input A', form.a, dsOptions, (v) => set({ a: v })),
  ];
  if (binary) fields.push(select('Input B', form.b, dsOptions, (v) => set({ b: v })));
  if (form.op === 'add') {
    fields.push(el('div', { class: 'field-row' }, [textField('Weight a', form.wa, (v) => set({ wa: v })), textField('Weight b', form.wb, (v) => set({ wb: v }))]));
  }
  if (form.op === 'scale') fields.push(textField('Factor k (≥ 0)', form.k, (v) => set({ k: v })));
  if (form.op === 'divide') {
    fields.push(textField('Denominator floor (cd)', form.floor, (v) => set({ floor: v }), { placeholder: B ? `default ${fmtCd(defaultFloor(B))}` : 'default 0.1% of B peak' }));
  }
  if (form.op === 'rotate') {
    fields.push(
      el('p', { class: 'note', text: 'Yaw + moves the beam right, pitch + moves it up, roll + turns it clockwise as seen from the lamp looking forward. Applied roll, then pitch, then yaw.' }),
      el('div', { class: 'field-row' }, [textField('Yaw °', form.yaw, (v) => set({ yaw: v })), textField('Roll °', form.roll, (v) => set({ roll: v }))]),
      el('div', { class: 'field-row' }, [
        textField(form.pitchUnit === 'percent' ? 'Pitch % (inclination)' : 'Pitch °', form.pitch, (v) => set({ pitch: v })),
        select('Pitch unit', form.pitchUnit, [
          { value: 'deg', label: 'degrees' },
          { value: 'percent', label: 'percent (atan(p/100))' },
        ], (v) => set({ pitchUnit: v as 'deg' | 'percent' })),
      ]),
      select('Target grid', form.rtarget, [
        { value: 'same', label: 'Same grid as the input (default)' },
        { value: 'extended', label: 'Extended to contain the rotated coverage' },
      ], (v) => set({ rtarget: v as RotationTarget })),
    );
  }
  if (form.op === 'window') {
    fields.push(
      el('div', { class: 'field-row' }, [textField('H min °', form.hMin, (v) => set({ hMin: v })), textField('H max °', form.hMax, (v) => set({ hMax: v }))]),
      el('div', { class: 'field-row' }, [textField('V min °', form.vMin, (v) => set({ vMin: v })), textField('V max °', form.vMax, (v) => set({ vMax: v }))]),
    );
  }
  if (binary) {
    fields.push(
      select('Extent', form.extent, [
        { value: 'intersection', label: 'Intersection of coverages (default)' },
        { value: 'union', label: 'Union of coverages' },
      ], (v) => set({ extent: v as 'intersection' | 'union' })),
      el('fieldset', { class: 'policy' }, [
        el('legend', { text: 'Outside an input’s coverage' }),
        check('Treat A as zero (otherwise no data)', form.zeroA, (v) => set({ zeroA: v })),
        check('Treat B as zero (otherwise no data)', form.zeroB, (v) => set({ zeroB: v })),
      ]),
    );
  }

  const sum = summary(A, B);
  const nameInput = el('input', { class: 'name-input', attrs: { type: 'text', 'aria-label': 'Name of the result', placeholder: 'Name (optional)' } });
  nameInput.value = form.name;
  nameInput.addEventListener('change', () => (form.name = nameInput.value));
  const attempt = (then: (r: RunResult) => void) => {
    form.name = nameInput.value;
    try {
      then(run(A, B));
      form.message = '';
    } catch (e) {
      form.message = e instanceof Error ? e.message : String(e);
      rerender();
    }
  };
  const previewBtn = el('button', {
    class: 'btn',
    text: 'Preview',
    on: {
      click: () =>
        attempt((r) =>
          store.setPreview(r.dataset, { ...(r.compareTo ? { compareTo: r.compareTo } : {}), ...(r.report ? { report: r.report } : {}) }),
        ),
    },
  });
  const createBtn = el('button', {
    class: 'btn primary',
    text: 'Create dataset',
    on: {
      click: () =>
        attempt((r) => {
          form.name = '';
          store.addDerived(r.dataset, nameInput.value);
        }),
    },
  });
  previewBtn.disabled = !sum.ok;
  createBtn.disabled = !sum.ok;

  root.replaceChildren(
    el('div', { class: 'manipulate' }, [
      ...fields,
      form.op === 'add'
        ? el('p', { class: 'note', text: 'Assumes both files share the same aim and reference axis. Lamp position offset is ignored (far field).' })
        : null,
      el('h3', { text: 'What will happen' }),
      el('p', { class: sum.ok ? 'summary-text' : 'summary-text summary-error', text: sum.text }),
      form.op === 'rotate' && state.preview?.report ? reportBox(state.preview.report, state.preview.dataset.kind as Kind) : null,
      el('label', { class: 'field' }, [el('span', { text: 'Name' }), nameInput]),
      el('div', { class: 'btn-row' }, [previewBtn, createBtn]),
      form.message ? el('p', { class: 'export-msg', attrs: { role: 'alert' }, text: form.message }) : null,
    ].filter((n): n is HTMLElement => n !== null)),
  );
}

/** The rotation report shown before "Create dataset". */
function reportBox(r: RotationReport, kind: Kind): HTMLElement {
  const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
  const peak = (p: { value: number; h: number; v: number }) => `${fmtValue(kind, p.value)} at H ${fmtDeg(p.h)}, V ${fmtDeg(p.v)}`;
  const sign = r.fluxChangePercent > 0 ? '+' : '';
  const rows: HTMLElement[] = [
    el('dt', { text: 'Outside source coverage' }),
    el('dd', { text: `${pct(r.outsideFraction)} of target nodes` }),
    el('dt', { text: 'Flux before → after' }),
    el('dd', { text: `${fmtLm(r.fluxBefore)} → ${fmtLm(r.fluxAfter)} (${sign}${r.fluxChangePercent.toFixed(3)}%)` }),
    el('dt', { text: 'Peak before' }),
    el('dd', { text: peak(r.peakBefore) }),
    el('dt', { text: 'Peak after' }),
    el('dd', { text: peak(r.peakAfter) }),
    el('dt', { text: 'Method' }),
    el('dd', {
      text:
        (r.fastPath ? 'exact H shift (pure yaw), no resampling' : 'true rotation, bilinear resampling') +
        (r.composed ? `; composed: total yaw ${r.composedAngles.yaw.toFixed(3)}°, pitch ${r.composedAngles.pitch.toFixed(3)}°, roll ${r.composedAngles.roll.toFixed(3)}°` : ''),
    }),
  ];
  return el('div', { class: 'report' }, [
    el('h3', { text: 'Rotation report (preview)' }),
    el('dl', { class: 'kv' }, rows),
    r.outsideFraction > OUTSIDE_WARNING
      ? el('p', {
          class: 'note warn',
          attrs: { role: 'alert' },
          text: `${pct(r.outsideFraction)} of the target grid has no source data after rotation (more than ${pct(OUTSIDE_WARNING)}). Consider the extended target grid, or check the angles.`,
        })
      : null,
  ].filter((n): n is NonNullable<typeof n> => n !== null));
}
