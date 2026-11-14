import { messageText, toUserMessage } from '../core/messages';
import { EMPTY_ROAD_LAMP, type AppState, type RoadLampSettings, type RoadSettings, type Store } from './state/store';
import { el } from './dom';
import { downloadText } from './download';
import { lampPair, mirrorAim, parseVehiclePreset, type VehiclePreset } from '../core/road/setup';
import { parseRequirements, type RequirementResult, type RoadRequirements } from '../core/road/requirements';
import { lineLabel, roadResultsToCsv } from '../core/road/results';
import { prepare, runState, schedule } from './road-run';
import { fmtLx as lx, fmtM, fmtPct, fmtStatus } from './format';

// ── Bundled files ─────────────────────────────────────────────────────────

const presetFiles = import.meta.glob<unknown>('../data/presets/vehicles/*.json', { import: 'default', eager: true });
const PRESETS: Array<{ file: string; preset: VehiclePreset }> = [];
for (const [file, obj] of Object.entries(presetFiles)) {
  try {
    PRESETS.push({ file: file.replace('../', ''), preset: parseVehiclePreset(obj) });
  } catch {
    /* listed as invalid below */
  }
}

interface ReqEntry {
  key: string;
  req: RoadRequirements;
  origin: string;
}
const reqFiles = import.meta.glob<unknown>('../data/requirements/*.json', { import: 'default', eager: true });
const REQS: ReqEntry[] = [];
const invalidReqs: string[] = [];
for (const [file, obj] of Object.entries(reqFiles)) {
  if (file.endsWith('/schema.json')) continue;
  try {
    const req = parseRequirements(obj);
    REQS.push({ key: `data:${req.id}`, req, origin: file.replace('../', '') });
  } catch (e) {
    invalidReqs.push(`${file.replace('../', '')}: ${messageText(toUserMessage(e))}`);
  }
}
const loadedReqs: ReqEntry[] = [];
let reqMessage = '';
let pairMessage = '';

export function requirementEntry(state: AppState): ReqEntry | null {
  return [...REQS, ...loadedReqs].find((r) => r.key === state.road.reqKey) ?? null;
}

// ── Small field helpers ───────────────────────────────────────────────────

const fmt = (x: number | null | undefined, d = 2) => fmtM(x, d);
const fmtLx = (x: number) => (Number.isNaN(x) ? 'no data' : lx(x));

function numField(label: string, value: number | null, onChange: (v: number | null) => void, opts: { required?: boolean; placeholder?: string } = {}): HTMLElement {
  const i = el('input', { attrs: { type: 'text', inputmode: 'decimal', 'aria-label': label, placeholder: opts.placeholder ?? (opts.required ? 'required' : '') } });
  i.value = value === null ? '' : String(value);
  if (opts.required && value === null) i.classList.add('needs-value');
  i.addEventListener('change', () => {
    const t = i.value.trim().replace(',', '.');
    if (t === '') return onChange(null);
    const x = Number(t);
    if (Number.isFinite(x)) onChange(x);
    else i.value = value === null ? '' : String(value);
  });
  return el('label', { class: 'field' }, [el('span', { text: label }), i]);
}

function datasetSelect(state: AppState, label: string, value: string | null, onChange: (key: string | null) => void, firstText = 'Choose a dataset…'): HTMLElement {
  const usable = state.entries.filter((e) => e.dataset && e.dataset.kind === 'intensity');
  const sel = el('select', { attrs: { 'aria-label': label } }, [
    el('option', { text: firstText, attrs: { value: '' } }),
    ...usable.map((e) => el('option', { text: e.name, attrs: { value: e.key } })),
  ]);
  sel.value = usable.some((e) => e.key === value) ? value! : '';
  sel.addEventListener('change', () => onChange(sel.value || null));
  return el('label', { class: 'field' }, [el('span', { text: label }), sel]);
}

function check(label: string, value: boolean, onChange: (v: boolean) => void): HTMLElement {
  const i = el('input', { attrs: { type: 'checkbox' } });
  i.checked = value;
  i.addEventListener('change', () => onChange(i.checked));
  return el('label', { class: 'check' }, [i, el('span', { text: label })]);
}

// ── Panel ─────────────────────────────────────────────────────────────────

export function renderRoad(root: HTMLElement, state: AppState, store: Store): void {
  const s = state.road;
  const set = (patch: Partial<RoadSettings>) => store.setRoad(patch);
  const setLamp = (i: number, patch: Partial<RoadLampSettings>) => set({ lamps: s.lamps.map((l, k) => (k === i ? { ...l, ...patch } : l)) });
  const parts: Array<HTMLElement | null> = [];

  parts.push(el('p', { class: 'muted small', text: 'Road illuminance from the lamps below. Vehicle frame: x forward, y right, z up (m); origin on the ground below the vehicle front centre. Aim signs as on the Manipulate tab: yaw + right, pitch + up, roll + clockwise seen from the lamp.' }));

  // Lamp pair helper
  const p = s.pair;
  const setPair = (patch: Partial<RoadSettings['pair']>) => set({ pair: { ...p, ...patch } });
  const mirrorSel = el('select', { attrs: { 'aria-label': 'Mirrored lamp' } }, [
    el('option', { text: 'No lamp mirrored', attrs: { value: 'none' } }),
    el('option', { text: 'Right lamp uses the file mirrored', attrs: { value: 'right' } }),
    el('option', { text: 'Left lamp uses the file mirrored', attrs: { value: 'left' } }),
  ]);
  mirrorSel.value = p.mirror;
  mirrorSel.addEventListener('change', () => setPair({ mirror: mirrorSel.value as RoadSettings['pair']['mirror'] }));
  const rightAimSel = el('select', { attrs: { 'aria-label': 'Right lamp aim' } }, [
    el('option', { text: 'Mirror image (yaw, roll change sign)', attrs: { value: 'mirrored' } }),
    el('option', { text: 'Same as left', attrs: { value: 'same' } }),
  ]);
  rightAimSel.value = p.rightAim;
  rightAimSel.addEventListener('change', () => setPair({ rightAim: rightAimSel.value as 'mirrored' | 'same' }));
  const setPairBtn = el('button', {
    class: 'btn primary',
    text: 'Set the two lamps',
    on: {
      click: () => {
        const left = state.entries.find((e) => e.key === p.leftKey)?.dataset ?? null;
        const right = p.rightKey ? (state.entries.find((e) => e.key === p.rightKey)?.dataset ?? null) : null;
        if (!left) {
          pairMessage = 'Choose the file for the left lamp.';
          return set({});
        }
        const aimLeft = p.yaw === null || p.pitch === null || p.roll === null ? null : { yaw: p.yaw, pitch: p.pitch, roll: p.roll };
        try {
          const [l, r] = lampPair({ left, right, mirror: p.mirror, separation: p.separation, height: p.height, x: p.x, aimLeft, aimRight: aimLeft && (p.rightAim === 'mirrored' ? mirrorAim(aimLeft) : aimLeft) });
          const toSettings = (lamp: typeof l, key: string): RoadLampSettings => ({
            entryKey: key, mirror: !!lamp!.mirror, x: lamp!.position.x, y: lamp!.position.y, height: lamp!.position.height, yaw: lamp!.aim.yaw, pitch: lamp!.aim.pitch, roll: lamp!.aim.roll,
          });
          pairMessage = '';
          set({ lamps: [toSettings(l, p.leftKey!), toSettings(r, p.rightKey ?? p.leftKey!)] });
        } catch (e) {
          pairMessage = toUserMessage(e).detail ?? messageText(toUserMessage(e));
          set({});
        }
      },
    },
  });
  const presetBtns = PRESETS.map(({ preset, file }) =>
    el('button', {
      class: 'btn',
      text: 'Fill in from EXAMPLE preset',
      title: `${preset.label} (${file}). Fills the pair and lane values below; the file must still be chosen.`,
      on: {
        click: () => {
          const L = preset.lamps;
          pairMessage = `Filled in from ${file}: ${preset.label}.`;
          set({
            pair: { ...p, mirror: L.mirror, separation: L.separation, height: L.height, x: L.x, yaw: L.aimLeft.yaw, pitch: L.aimLeft.pitch, roll: L.aimLeft.roll, rightAim: L.aimRight.yaw === -L.aimLeft.yaw && L.aimRight.roll === -L.aimLeft.roll && (L.aimLeft.yaw !== 0 || L.aimLeft.roll !== 0) ? 'mirrored' : 'same' },
            lanes: { ...preset.lanes },
          });
        },
      },
    }),
  );
  const pair = el('details', { class: 'report' }, [
    el('summary', { text: 'Lamp pair helper' }),
    el('div', { class: 'manipulate' }, ([
      el('div', { class: 'field-row' }, [
        datasetSelect(state, 'Left lamp file', p.leftKey, (k) => setPair({ leftKey: k })),
        datasetSelect(state, 'Right lamp file', p.rightKey, (k) => setPair({ rightKey: k }), 'Same file as left'),
      ]),
      el('label', { class: 'field' }, [el('span', { text: 'Mirroring' }), mirrorSel]),
      el('div', { class: 'field-row three' }, [
        numField('Separation (m)', p.separation, (v) => setPair({ separation: v }), { required: true }),
        numField('Mounting height (m)', p.height, (v) => setPair({ height: v }), { required: true }),
        numField('Position x (m)', p.x, (v) => setPair({ x: v }), { required: true }),
      ]),
      el('div', { class: 'field-row three' }, [
        numField('Left yaw (°)', p.yaw, (v) => setPair({ yaw: v }), { required: true }),
        numField('Left pitch (°)', p.pitch, (v) => setPair({ pitch: v }), { required: true }),
        numField('Left roll (°)', p.roll, (v) => setPair({ roll: v }), { required: true }),
      ]),
      el('label', { class: 'field' }, [el('span', { text: 'Right lamp aim' }), rightAimSel]),
      el('div', { class: 'btn-row' }, [setPairBtn, ...presetBtns]),
      pairMessage ? el('p', { class: 'small', attrs: { role: 'status' }, text: pairMessage }) : null,
    ] as Array<HTMLElement | null>).filter((n): n is HTMLElement => n !== null)),
  ]);
  pair.open = s.lamps.length === 0;
  parts.push(el('h3', { text: 'Lamps' }), pair);

  // Lamp list
  s.lamps.forEach((l, i) => {
    parts.push(
      el('fieldset', { class: 'policy road-lamp' }, [
        el('legend', { text: `Lamp ${i + 1}` }),
        datasetSelect(state, 'Dataset', l.entryKey, (k) => setLamp(i, { entryKey: k })),
        check('Use the file mirrored in H', l.mirror, (v) => setLamp(i, { mirror: v })),
        el('div', { class: 'field-row three' }, [
          numField('x (m)', l.x, (v) => setLamp(i, { x: v }), { required: true }),
          numField('y (m, + right)', l.y, (v) => setLamp(i, { y: v }), { required: true }),
          numField('Height (m)', l.height, (v) => setLamp(i, { height: v }), { required: true }),
        ]),
        el('div', { class: 'field-row three' }, [
          numField('Yaw (°)', l.yaw, (v) => setLamp(i, { yaw: v }), { required: true }),
          numField('Pitch (°)', l.pitch, (v) => setLamp(i, { pitch: v }), { required: true }),
          numField('Roll (°)', l.roll, (v) => setLamp(i, { roll: v }), { required: true }),
        ]),
        el('div', { class: 'btn-row' }, [el('button', { class: 'btn', text: 'Remove lamp', on: { click: () => set({ lamps: s.lamps.filter((_, k) => k !== i) }) } })]),
      ]),
    );
  });
  parts.push(el('div', { class: 'btn-row' }, [el('button', { class: 'btn', text: 'Add lamp', on: { click: () => set({ lamps: [...s.lamps, { ...EMPTY_ROAD_LAMP }] }) } })]));

  // Lanes
  const ln = s.lanes;
  const setLanes = (patch: Partial<RoadSettings['lanes']>) => set({ lanes: { ...ln, ...patch } });
  const side = el('select', { attrs: { 'aria-label': 'Traffic side' } }, [
    el('option', { text: 'Choose…', attrs: { value: '' } }),
    el('option', { text: 'Right-hand traffic (lane 1 rightmost)', attrs: { value: 'right' } }),
    el('option', { text: 'Left-hand traffic (lane 1 leftmost)', attrs: { value: 'left' } }),
  ]);
  side.value = ln.trafficSide ?? '';
  side.addEventListener('change', () => setLanes({ trafficSide: (side.value || null) as 'right' | 'left' | null }));
  parts.push(
    el('h3', { text: 'Lanes' }),
    el('div', { class: 'field-row three' }, [
      numField('Lane width (m)', ln.laneWidth, (v) => setLanes({ laneWidth: v })),
      numField('Number of lanes', ln.lanes, (v) => setLanes({ lanes: v })),
      numField('Own lane (1 = kerb side)', ln.ownLane, (v) => setLanes({ ownLane: v })),
    ]),
    el('div', { class: 'field-row' }, [
      el('label', { class: 'field' }, [el('span', { text: 'Traffic side' }), side]),
      numField('Vehicle offset from lane centre (m, + right)', ln.offset, (v) => setLanes({ offset: v })),
    ]),
  );

  // Grid
  const g = s.grid;
  const setGrid = (k: keyof RoadSettings['grid']) => (v: number | null) => v !== null && set({ grid: { ...g, [k]: v } });
  parts.push(
    el('h3', { text: 'Road grid' }),
    el('div', { class: 'field-row three' }, [numField('x min (m)', g.xMin, setGrid('xMin')), numField('x max (m)', g.xMax, setGrid('xMax')), numField('x step (m)', g.xStep, setGrid('xStep'))]),
    el('div', { class: 'field-row three' }, [numField('y min (m)', g.yMin, setGrid('yMin')), numField('y max (m)', g.yMax, setGrid('yMax')), numField('y step (m)', g.yStep, setGrid('yStep'))]),
    check('Treat directions without data as 0 lx (default: unknown)', s.outsideZero, (v) => set({ outsideZero: v })),
  );

  // Result inputs
  const textField = (label: string, value: string, onChange: (v: string) => void, placeholder: string, area = false) => {
    const i = area ? el('textarea', { attrs: { rows: '3', 'aria-label': label, placeholder } }) : el('input', { attrs: { type: 'text', 'aria-label': label, placeholder } });
    i.value = value;
    i.addEventListener('change', () => onChange(i.value));
    return el('label', { class: 'field' }, [el('span', { text: label }), i]);
  };
  parts.push(
    el('h3', { text: 'Results to show' }),
    textField('Isolux levels (lx)', s.levelsText, (v) => set({ levelsText: v }), 'e.g. 1, 3'),
    el('div', { class: 'field-row' }, [
      textField('Width at distances (m)', s.widthText, (v) => set({ widthText: v }), 'e.g. 10, 25, 50'),
      numField('Width level (lx)', s.widthLevel, (v) => set({ widthLevel: v })),
    ]),
    textField('Points: x y z road|vertical [name], one per line', s.pointsText, (v) => set({ pointsText: v }), '25 -1.75 0 road\n50 3 1.2 vertical sign', true),
  );

  // Requirements
  const reqs = [...REQS, ...loadedReqs];
  const reqSel = el('select', { attrs: { 'aria-label': 'Requirement file' } }, [
    el('option', { text: 'No requirement check', attrs: { value: '' } }),
    ...reqs.map((r) => el('option', { text: `${r.req.title}${r.req.verified ? '' : ' [unverified]'}`, attrs: { value: r.key } })),
  ]);
  reqSel.value = reqs.some((r) => r.key === s.reqKey) ? s.reqKey! : '';
  reqSel.addEventListener('change', () => set({ reqKey: reqSel.value || null }));
  const reqPicker = el('input', { attrs: { type: 'file', accept: '.json,application/json', 'aria-label': 'Load a requirement JSON file' } });
  reqPicker.addEventListener('change', async () => {
    const f = reqPicker.files?.[0];
    if (!f) return;
    try {
      const req = parseRequirements(JSON.parse(await f.text()));
      const entry = { key: `file:${f.name}:${req.id}`, req, origin: `loaded from ${f.name} (this session only)` };
      const k = loadedReqs.findIndex((r) => r.key === entry.key);
      if (k >= 0) loadedReqs.splice(k, 1, entry);
      else loadedReqs.push(entry);
      reqMessage = '';
      set({ reqKey: entry.key });
    } catch (e) {
      reqMessage = `${f.name}: ${messageText(toUserMessage(e))}`;
      set({});
    }
  });
  const reqEntry = requirementEntry(state);
  parts.push(
    el('h3', { text: 'Requirements' }),
    el('label', { class: 'field' }, [el('span', { text: 'Requirement file (data/requirements/ or loaded)' }), reqSel]),
    el('label', { class: 'field' }, [el('span', { text: 'Load a requirement file (JSON, kept in memory for this session)' }), reqPicker]),
    reqMessage ? el('pre', { class: 'export-msg chain', text: reqMessage }) : null,
    invalidReqs.length ? el('ul', { class: 'warnings' }, invalidReqs.map((x) => el('li', { class: 'w-warn', text: `Invalid: ${x}` }))) : null,
    reqEntry && !reqEntry.req.verified
      ? el('p', { class: 'banner-unverified', text: 'Unverified requirement file ("verified": false): results are not a compliance statement.' })
      : null,
  );

  // Run
  const prep = prepare(state, reqEntry?.req ?? null);
  schedule(prep.input, () => store.setRoad({}));
  const run = runState();
  parts.push(el('h3', { text: 'Results' }));
  if (prep.missing.length) parts.push(el('ul', { class: 'warnings' }, prep.missing.map((m) => el('li', { class: 'w-info', text: m }))));
  if (prep.warnings.length) parts.push(el('ul', { class: 'warnings' }, prep.warnings.map((m) => el('li', { class: 'w-warn', text: m }))));
  if (run.error) parts.push(el('p', { class: 'export-msg', attrs: { role: 'alert' }, text: run.error }));
  if (prep.input && run.running) parts.push(el('p', { class: 'muted small', attrs: { role: 'status' }, text: 'Calculating…' }));
  const r = prep.input && !run.running ? run.result : null;
  if (r && run.input) {
    const f = r.field;
    parts.push(
      el('dl', { class: 'kv small' }, [
        el('dt', { text: 'Maximum' }),
        el('dd', { text: r.max ? `${fmtLx(r.max.value)} lx at x ${fmt(r.max.x)} m, y ${fmt(r.max.y)} m` : '—' }),
        el('dt', { text: 'Unknown' }),
        el('dd', { text: f.outside === 'zero' ? 'none (directions without data counted as 0 lx)' : `${fmtPct(f.unknownFraction * 100, 1)} of the road grid (no data in that direction)` }),
        el('dt', { text: 'Calculated' }),
        el('dd', { text: `${f.values.length.toLocaleString('en')} points in ${Math.round(r.ms)} ms${run.inWorker ? ' (Web Worker)' : ''}` }),
      ]),
    );

    if (r.reaches.length) {
      const levels = [...new Set(r.reaches.map((x) => x.level))];
      const lines = [...new Set(r.reaches.map((x) => x.line))];
      parts.push(
        el('table', { class: 'cut-table' }, [
          el('thead', {}, [el('tr', {}, [el('th', { text: 'Reach (m)' }), ...levels.map((lv) => el('th', { text: `${lv} lx` }))])]),
          el('tbody', {}, lines.map((line) =>
            el('tr', {}, [
              el('th', { text: `${lineLabel(line)} (y ${fmt(r.reaches.find((x) => x.line === line)!.y)})` }),
              ...levels.map((lv) => {
                const x = r.reaches.find((q) => q.line === line && q.level === lv)!;
                const flags = [x.multiple ? `crosses ${x.crossings.length}×: ${x.crossings.map((c) => `${c.direction} ${fmt(c.at)}`).join(', ')}` : '', x.beyondEnd ? 'still above at the grid end' : '', x.unknownBeyond ? 'unknown areas beyond' : ''].filter(Boolean);
                return el('td', { text: `${x.reach === null ? 'not reached' : (x.beyondEnd ? '≥ ' : '') + fmt(x.reach)}${flags.length ? ' ⚑' : ''}`, title: flags.join('; ') });
              }),
            ]),
          )),
        ]),
      );
      if (r.reaches.some((x) => x.multiple)) parts.push(el('p', { class: 'small note', text: '⚑ The curve crosses the level more than once on a line: the furthest crossing is reported; hover for all crossings.' }));
    } else parts.push(el('p', { class: 'muted small', text: 'Enter isolux levels to see the reach.' }));

    if (r.widths.length) {
      parts.push(
        el('table', { class: 'cut-table' }, [
          el('thead', {}, [el('tr', {}, [el('th', { text: `Width at ${run.input.widthLevel} lx` }), el('th', { text: 'From y' }), el('th', { text: 'To y' }), el('th', { text: 'Width (m)' })])]),
          el('tbody', {}, r.widths.map((w) => {
            const flags = [w.multiple ? 'separate areas' : '', w.clipped ? 'reaches the grid edge' : '', w.unknownAdjacent ? 'runs into unknown' : ''].filter(Boolean);
            return el('tr', { title: flags.join('; ') }, [el('th', { text: `x ${fmt(w.x)} m` }), el('td', { text: fmt(w.from) }), el('td', { text: fmt(w.to) }), el('td', { text: `${w.width === null ? 'not reached' : fmt(w.width)}${flags.length ? ' ⚑' : ''}` })]);
          })),
        ]),
      );
    }
    if (r.points.length) {
      parts.push(
        el('table', { class: 'cut-table' }, [
          el('thead', {}, [el('tr', {}, [el('th', { text: 'Point' }), el('th', { text: 'x, y, z (m)' }), el('th', { text: 'Plane' }), el('th', { text: 'E (lx)' })])]),
          el('tbody', {}, r.points.map((pt) => el('tr', {}, [
            el('th', { text: pt.name }),
            el('td', { text: pt.point.map((v) => fmt(v)).join(', ') }),
            el('td', { text: pt.normal && pt.normal[0] === -1 ? 'vertical' : 'road' }),
            el('td', { text: fmtLx(pt.value) }),
          ]))),
        ]),
      );
    }

    const rq = r.requirements;
    if (rq) {
      const fmtM = (e: RequirementResult, x: number | null) => (x === null ? '—' : `${e.unit === 'lx' ? fmtLx(x) : fmt(x)} ${e.unit}`);
      parts.push(
        el('div', { class: `verdict verdict-${rq.overall}` }, [
          el('strong', { text: fmtStatus(rq.overall).toUpperCase() }),
          el('span', { text: ` ${rq.counts.pass} pass, ${rq.counts.fail} fail, ${rq.counts.notEvaluated} not evaluated. Worst margin: ${rq.worst ?? '—'}.` }),
        ]),
        el('table', { class: 'cut-table eval-table' }, [
          el('thead', {}, [el('tr', {}, ['Requirement', 'Measured', 'Limit', 'Margin', 'Margin %', 'Status'].map((h) => el('th', { text: h })))]),
          el('tbody', {}, rq.elements.map((e) =>
            el('tr', { class: e.name === rq.worst ? 'worst' : '', title: [e.ref ? `Source: ${e.ref}` : '', e.reason ?? '', e.flags.join('; ')].filter(Boolean).join(' — ') }, [
              el('th', { text: e.name }),
              el('td', { text: fmtM(e, e.measured) + (e.flags.length ? ' ⚑' : '') }),
              el('td', { text: e.limit ? `${e.limit.kind} ${fmtM(e, e.limit.value)}` : '—' }),
              el('td', { text: e.margin === null ? '—' : fmtM(e, e.margin) }),
              el('td', { text: fmtPct(e.marginPercent, 1, true) }),
              el('td', { class: `st st-${e.status}`, text: fmtStatus(e.status) }),
            ]),
          )),
        ]),
      );
    }
    const input = run.input;
    parts.push(
      el('div', { class: 'btn-row' }, [
        el('button', { class: 'btn', text: 'Export results CSV', on: { click: () => downloadText('beamLab-road-results.csv', roadResultsToCsv(input, r), 'text/csv') } }),
      ]),
    );
  }
  root.replaceChildren(...parts.filter((n): n is HTMLElement => n !== null));
}
