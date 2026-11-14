import type { PhotometricDataset } from '../model/dataset';
import type { IesWarning } from '../io/ies';
import { summarize, type DatasetSummary } from '../analysis/summary';
import { displayGrid } from '../analysis/display';
import { autoLevels } from '../analysis/levels';
import { contourLines, toLineXY } from '../analysis/contours';
import { provenanceChain } from '../model/provenance';
import { percentDownFromV } from '../ops/aim';
import { geometryOutline } from '../regs/engine';
import type { Regulation } from '../regs/schema';
import type { AimedEvaluation } from '../regs/reaim';
import type { ScanResult, SharpnessResult, TraceResult } from '../analysis/cutoff';
import { fitSegments } from '../analysis/cutoff';
import type { RoadRunInput, RoadRunResult } from '../road/results';
import { lineLabel } from '../road/results';
import type { RoadLayout } from '../road/setup';
import { fmtCd, fmtDeg, fmtDegFixed, fmtLm, fmtLx, fmtM, fmtPct, fmtSig, fmtStatus, fmtStep } from '../format';

/**
 * Report (Phase 8): a plain object built from the current results. The UI
 * renders it as a printable page; tests check the object, not the pixels.
 * Every number is formatted here (core/format.ts); plots carry their data.
 */

export const REPORT_FOOTER = 'Engineering assessment generated locally. Not a type-approval document.';
export const UNVERIFIED_NOTICE =
  'Unverified limits: this file has "verified": false. Its values have not been checked against the official text, so these results are not a compliance statement.';

export type SectionId = 'header' | 'files' | 'provenance' | 'regulation' | 'cutoff' | 'road' | 'conventions';
export const SECTION_IDS: SectionId[] = ['header', 'files', 'provenance', 'regulation', 'cutoff', 'road', 'conventions'];
export const SECTION_TITLES: Record<SectionId, string> = {
  header: 'Report',
  files: 'File identity',
  provenance: 'Provenance of the evaluated dataset',
  regulation: 'Regulation check',
  cutoff: 'Cut-off analysis',
  road: 'Road performance',
  conventions: 'Conventions',
};

export interface ReportOptions {
  sections: Record<SectionId, boolean>;
  title: string;
  author: string;
  notes: string;
}

export const DEFAULT_REPORT_OPTIONS: ReportOptions = {
  sections: { header: true, files: true, provenance: true, regulation: true, cutoff: true, road: true, conventions: true },
  title: '',
  author: '',
  notes: '',
};

export interface ReportDataset {
  name: string;
  /** SHA-256 of the file content (hex); null for derived datasets. */
  sha256: string | null;
  origin: 'file' | 'derived';
  /** Role in this report, e.g. "evaluated", "road lamp 1". */
  roles: string[];
  dataset: PhotometricDataset;
  warnings: IesWarning[];
  flipH: boolean;
}

export interface CutoffSettingsUsed {
  scanH: number;
  vMin: number;
  vMax: number;
  step: number;
  traffic: 'RHT' | 'LHT';
  hMin: number;
  hMax: number;
  hStep: number;
  presetTitle: string | null;
}

export interface ReportInput {
  options: ReportOptions;
  appVersion: string;
  /** ISO 8601 time of generation. */
  generated: string;
  datasets: ReportDataset[];
  /** Dataset the regulation check, cut-off analysis and provenance refer to. */
  evaluated: PhotometricDataset | null;
  regulation: { reg: Regulation; evaluation: AimedEvaluation; aimModeLabel: string } | null;
  cutoff: { datasetName: string; settings: CutoffSettingsUsed; scan: ScanResult; trace: TraceResult; sharpness: SharpnessResult; dataset: PhotometricDataset } | null;
  road: { input: RoadRunInput; result: RoadRunResult; layout: RoadLayout | null; requirementsVerified: boolean | null } | null;
}

// ── Report object ──────────────────────────────────────────────────────────

export type CellStatus = 'pass' | 'fail' | 'not-evaluated';
export interface Cell {
  text: string;
  status?: CellStatus;
}
export type Block =
  | { type: 'kv'; rows: Array<[string, string]> }
  | { type: 'table'; caption: string; columns: string[]; rows: Cell[][] }
  | { type: 'notice'; level: 'unverified' | 'warning' | 'info'; text: string }
  | { type: 'text'; text: string; pre?: boolean }
  | { type: 'plot'; plot: PlotSpec };

export type PlotSpec =
  | {
      kind: 'isocandela';
      title: string;
      h: number[];
      v: number[];
      contours: Array<{ level: number; label: string; x: (number | null)[]; y: (number | null)[] }>;
      elements: Array<{ name: string; status: CellStatus; h: number[]; v: number[] }>;
    }
  | { kind: 'cutoff-scan'; title: string; v: number[]; logI: (number | null)[]; g: (number | null)[]; cutoffV: number | null }
  | { kind: 'cutoff-trace'; title: string; points: Array<{ h: number; v: number }>; horizontal: Array<[number, number]>; shoulder: Array<[number, number]>; elbow: { h: number; v: number } | null }
  | {
      kind: 'road';
      title: string;
      x: number[];
      y: number[];
      /** log10 lx, null where unknown or ≤ 0, rows = y. */
      z: (number | null)[][];
      contours: Array<{ level: number; label: string; x: (number | null)[]; y: (number | null)[] }>;
      markings: Array<{ y: number; kind: 'edge' | 'lane' }>;
      lamps: Array<{ x: number; y: number }>;
      zmin: number;
      zmax: number;
    };

export interface ReportSection {
  id: SectionId;
  title: string;
  blocks: Block[];
}

export interface Report {
  meta: { tool: string; version: string; generated: string; title: string; author: string; notes: string };
  footer: string;
  /** Every "not evaluated" item in the included sections. */
  notEvaluated: Array<{ section: string; item: string; reason: string }>;
  /** Sections that carry the unverified-limits notice. */
  unverified: string[];
  sections: ReportSection[];
}

// ── Builders ───────────────────────────────────────────────────────────────

function fileIdentity(d: ReportDataset): Block[] {
  const ds = d.dataset;
  const s: DatasetSummary = summarize(ds);
  const rows: Array<[string, string]> = [
    ['Name', d.name + (d.flipH ? ' (mirrored in H on load)' : '')],
    ['Used as', d.roles.join(', ') || '—'],
    ['Origin', d.origin === 'file' ? 'IES file' : 'derived (result of an operation)'],
    ['SHA-256', d.sha256 ?? (d.origin === 'file' ? 'not computed' : 'not applicable (derived)')],
    ['Format version', ds.meta.sourceFormat],
    ['Photometric type', `Type ${ds.meta.sourceType}${ds.meta.sourceType === 'A' ? '' : ' (converted to Type A)'}`],
    ['Kind', ds.kind],
    ['Grid step', `H ${fmtStep(s.step.h)}, V ${fmtStep(s.step.v)}`],
    ['Angular range', `H ${fmtDeg(s.range.hMin)} to ${fmtDeg(s.range.hMax)}, V ${fmtDeg(s.range.vMin)} to ${fmtDeg(s.range.vMax)}`],
    ['Peak', s.maxAt ? `${fmtCd(s.maxIntensity)} cd at H ${fmtDeg(s.maxAt.h)}, V ${fmtDeg(s.maxAt.v)}` : '—'],
    ['Flux (covered range)', ds.kind === 'intensity' ? fmtLm(s.flux) : '—'],
  ];
  const blocks: Block[] = [{ type: 'kv', rows }];
  blocks.push(
    d.warnings.length
      ? { type: 'table', caption: `Parser warnings: ${d.name}`, columns: ['Code', 'Severity', 'Message'], rows: d.warnings.map((w) => [{ text: w.code }, { text: w.severity }, { text: w.message }]) }
      : { type: 'text', text: 'Parser warnings: none.' },
  );
  return blocks;
}

function isocandela(ds: PhotometricDataset, title: string, elements: Array<{ name: string; status: CellStatus; h: number[]; v: number[] }>): PlotSpec {
  const g = displayGrid(ds, { scale: 'linear', maxPerAxis: 300 });
  const s = summarize(ds);
  const levels = autoLevels(s.maxIntensity, 'log', { min: s.maxIntensity / 1000 });
  return {
    kind: 'isocandela',
    title,
    h: g.h,
    v: g.v,
    contours: levels.map((level) => ({ level, label: `${fmtCd(level)} cd`, ...toLineXY(contourLines(g.h, g.v, g.z, level)) })),
    elements,
  };
}

const statusCell = (s: CellStatus | 'incomplete'): Cell => ({ text: fmtStatus(s), ...(s === 'incomplete' ? {} : { status: s }) });

function regulationSection(r: NonNullable<ReportInput['regulation']>, ne: Report['notEvaluated'], unverified: string[]): Block[] {
  const { reg, evaluation: ev } = r;
  const res = ev.result;
  const c = res.conditions;
  const blocks: Block[] = [];
  if (!reg.verified) {
    blocks.push({ type: 'notice', level: 'unverified', text: UNVERIFIED_NOTICE });
    unverified.push(SECTION_TITLES.regulation);
  }
  const worst = res.elements.find((e) => e.name === res.worst);
  const isRatio = (t: string) => t === 'ratio';
  const val = (t: string, x: number | null) => (x === null ? '—' : isRatio(t) ? fmtSig(x, 4) : `${fmtCd(x)} cd`);
  blocks.push({
    type: 'kv',
    rows: [
      ['Regulation', `${reg.title} (id ${reg.id})`],
      ['Source', reg.source ?? 'not given'],
      ['Revision', reg.revision ?? 'not given'],
      ['Verified', reg.verified ? 'yes' : 'no'],
      ['Traffic side', c.traffic === 'RHT' ? 'right-hand traffic' : `left-hand traffic${c.mirrored ? ' (elements mirrored in H)' : ''}`],
      ['Aim mode', r.aimModeLabel],
      ['Aim used', `yaw ${fmtDegFixed(ev.aim.yaw)}, pitch ${fmtDegFixed(ev.aim.pitch)} (relative to the dataset as loaded)`],
      ['Test conditions', `scale factor ${fmtSig(c.scaleFactor, 6)} × ${c.lamps} lamp(s) = ${fmtSig(c.factor, 6)}; file units ${c.units}`],
      ['Overall verdict', fmtStatus(res.overall).toUpperCase()],
      ['Counts', `${res.counts.pass} pass, ${res.counts.fail} fail, ${res.counts.notEvaluated} not evaluated`],
      ['Worst margin', worst ? `${worst.name} (${fmtPct(worst.marginPercent, 2, true)})` : '—'],
    ],
  });
  for (const n of ev.notes) blocks.push({ type: 'notice', level: 'info', text: n });
  blocks.push({
    type: 'table',
    caption: `Results: ${reg.title}`,
    columns: ['Element', 'Type', 'Measured', 'Limit', 'Margin', 'Margin %', 'Status', 'Reference / reason'],
    rows: res.elements.map((e) => {
      if (e.status === 'not-evaluated') ne.push({ section: SECTION_TITLES.regulation, item: e.name, reason: e.reason ?? 'not evaluated' });
      return [
        { text: e.name },
        { text: e.type },
        { text: val(e.type, e.measured) },
        { text: e.limit ? `${e.limit.kind} ${val(e.type, e.limit.value)}` : '—' },
        { text: e.margin === null ? '—' : val(e.type, e.margin) },
        { text: fmtPct(e.marginPercent, 2, true) },
        statusCell(e.status),
        { text: [e.ref, e.reason].filter(Boolean).join(' — ') || '—' },
      ];
    }),
  });
  blocks.push({
    type: 'plot',
    plot: isocandela(
      ev.dataset,
      `Isocandela (cd) of ${ev.dataset.name} at the aim used, with the regulation elements`,
      res.elements.filter((e) => e.geometry.kind !== 'none').map((e) => ({ name: e.name, status: e.status, ...geometryOutline(e.geometry) })),
    ),
  });
  return blocks;
}

function cutoffSection(c: NonNullable<ReportInput['cutoff']>, ne: Report['notEvaluated']): Block[] {
  const s = c.settings;
  const { scan, trace, sharpness } = c;
  const f = trace.fit;
  if (sharpness.status === 'no-limits') ne.push({ section: SECTION_TITLES.cutoff, item: 'Sharpness (Gmax)', reason: 'no limits in the chosen preset' });
  const blocks: Block[] = [
    {
      type: 'kv',
      rows: [
        ['Dataset', c.datasetName],
        ['Preset', s.presetTitle ?? 'none (tab settings)'],
        ['Vertical scan', `H ${fmtDeg(s.scanH)}, V ${fmtDeg(s.vMin)} to ${fmtDeg(s.vMax)}, step ${fmtDeg(s.step, 3)}`],
        ['Line trace', `H ${fmtDeg(s.hMin)} to ${fmtDeg(s.hMax)}, step ${fmtDeg(s.hStep)}`],
        ['Traffic side', s.traffic === 'RHT' ? 'right-hand traffic' : 'left-hand traffic'],
      ],
    },
    {
      type: 'table',
      caption: 'Cut-off summary',
      columns: ['Quantity', 'Value'],
      rows: [
        ['Cut-off found', scan.found ? 'yes' : 'no'],
        ['Cut-off V', scan.found ? `${fmtDegFixed(scan.v)} (${fmtPct(percentDownFromV(scan.v), 2)} down)` : '—'],
        ['Gmax (log10 per 0.1°)', fmtSig(scan.gMax, 3)],
        ['Native V step in the window', `${fmtDeg(scan.nativeStep, 3)}${scan.coarse ? ' (coarser than 0.1°: G is an interpolation artefact)' : ''}`],
        ['Other edges', scan.secondary.length ? scan.secondary.map((x) => `V ${fmtDegFixed(x.v)} (G ${fmtSig(x.g, 3)})`).join('; ') : 'none'],
        ['Horizontal part, mean V', f ? fmtDegFixed(f.horizontal.meanV) : '—'],
        ['Horizontal part, inclination', f ? fmtDegFixed(f.horizontal.slopeDeg) : '—'],
        ['Straightness (max / RMS deviation)', f ? `${fmtDegFixed(f.horizontal.maxDev)} / ${fmtDegFixed(f.horizontal.rmsDev)}` : '—'],
        ['Elbow', f ? `H ${fmtDegFixed(f.elbow.h)}, V ${fmtDegFixed(f.elbow.v)}` : '—'],
        ['Shoulder angle', f ? fmtDegFixed(f.shoulderAngle, 1) : '—'],
        ['Fit residual (RMS)', f ? `${fmtDegFixed(f.residualRms)}${trace.poorFit ? ' (poor fit)' : ''}` : (trace.reason ?? '—')],
        ['Sharpness', sharpness.status === 'no-limits' ? '– not evaluated (no limits in the preset)' : `${fmtStatus(sharpness.status)}${sharpness.margin !== null ? `, margin ${fmtSig(sharpness.margin, 3)}` : ''}`],
      ].map(([a, b]) => [{ text: a! }, { text: b! }]),
    },
    {
      type: 'plot',
      plot: { kind: 'cutoff-scan', title: `Vertical scan at H ${fmtDeg(s.scanH)}`, v: scan.curve.v, logI: scan.curve.i.map((x) => (x > 0 ? Math.log10(x) : null)), g: scan.curve.g.map((x) => (Number.isFinite(x) ? x : null)), cutoffV: scan.found ? scan.v : null },
    },
  ];
  const seg = f ? fitSegments(f, s.traffic, s.hMin, s.hMax) : { horizontal: [], shoulder: [] };
  blocks.push({
    type: 'plot',
    plot: { kind: 'cutoff-trace', title: 'Cut-off line trace and two-segment fit', points: trace.points.filter((p) => Number.isFinite(p.v)).map((p) => ({ h: p.h, v: p.v })), horizontal: seg.horizontal, shoulder: seg.shoulder, elbow: f ? f.elbow : null },
  });
  return blocks;
}

function roadSection(r: NonNullable<ReportInput['road']>, ne: Report['notEvaluated'], unverified: string[]): Block[] {
  const { input, result, layout } = r;
  const blocks: Block[] = [];
  blocks.push({
    type: 'table',
    caption: 'Lamps',
    columns: ['Lamp', 'Dataset', 'Mirrored', 'x (m)', 'y (m)', 'Height (m)', 'Yaw', 'Pitch', 'Roll'],
    rows: input.lamps.map((l, i) => [l.name ?? `Lamp ${i + 1}`, l.dataset.name, l.mirror ? 'yes' : 'no', fmtM(l.position.x), fmtM(l.position.y), fmtM(l.position.height), fmtDegFixed(l.aim.yaw), fmtDegFixed(l.aim.pitch), fmtDegFixed(l.aim.roll)].map((t) => ({ text: t }))),
  });
  const g = input.grid;
  blocks.push({
    type: 'kv',
    rows: [
      ['Lanes', layout ? `lane width ${fmtM(layout.laneWidth, 2, true)}; lane centre y ${fmtM(layout.lines['lane-centre'], 2, true)}; road from y ${fmtM(layout.road.yMin, 2, true)} to ${fmtM(layout.road.yMax, 2, true)}` : 'not entered (reach on the vehicle axis)'],
      ['Grid', `x ${fmtM(g.x.min)} to ${fmtM(g.x.max, 2, true)} step ${fmtM(g.x.step, 3, true)}; y ${fmtM(g.y.min)} to ${fmtM(g.y.max, 2, true)} step ${fmtM(g.y.step, 3, true)}`],
      ['Directions without data', input.outside === 'zero' ? 'counted as 0 lx (option set)' : `unknown: ${fmtPct(result.field.unknownFraction * 100, 1)} of the grid`],
      ['Maximum', result.max ? `${fmtLx(result.max.value)} lx at x ${fmtM(result.max.x, 2, true)}, y ${fmtM(result.max.y, 2, true)}` : '—'],
    ],
  });

  // Isolux plot
  const f = result.field;
  const nc = f.cols.length;
  const z: (number | null)[][] = [];
  const raw: (number | null)[][] = [];
  for (let iy = 0; iy < f.rows.length; iy++) {
    const zr: (number | null)[] = [];
    const rr: (number | null)[] = [];
    for (let ix = 0; ix < nc; ix++) {
      const v = f.values[iy * nc + ix]!;
      rr.push(Number.isFinite(v) ? v : null);
      zr.push(Number.isFinite(v) && v > 0 ? Math.log10(v) : null);
    }
    z.push(zr);
    raw.push(rr);
  }
  const zmax = result.max && result.max.value > 0 ? Math.log10(result.max.value) : 1;
  const zmin = Math.min(zmax - 4, input.levels.length ? Math.log10(input.levels[0]!) - 0.5 : zmax - 4);
  blocks.push({
    type: 'plot',
    plot: {
      kind: 'road', title: 'Road illuminance, top view (log colour scale, lx)', x: f.cols, y: f.rows, z, zmin, zmax,
      contours: input.levels.map((level) => ({ level, label: `${fmtLx(level)} lx`, ...toLineXY(contourLines(f.cols, f.rows, raw, level)) })),
      markings: layout?.markings ?? [],
      lamps: input.lamps.map((l) => ({ x: l.position.x, y: l.position.y })),
    },
  });

  if (result.reaches.length) {
    blocks.push({
      type: 'table',
      caption: 'Reach of the isolux levels',
      columns: ['Line', 'y (m)', 'Level', 'Reach', 'Crossings', 'Flags'],
      rows: result.reaches.map((x) => [
        { text: lineLabel(x.line) },
        { text: fmtM(x.y) },
        { text: `${fmtLx(x.level)} lx` },
        { text: x.reach === null ? 'not reached' : `${x.beyondEnd ? '≥ ' : ''}${fmtM(x.reach, 2, true)}` },
        { text: x.crossings.map((c) => `${c.direction} ${fmtM(c.at)}`).join(', ') || '—' },
        { text: [x.multiple ? 'multiple crossings' : '', x.beyondEnd ? 'still above at the grid end' : '', x.unknownBeyond ? 'unknown beyond' : ''].filter(Boolean).join('; ') || '—' },
      ]),
    });
  }
  if (result.widths.length) {
    blocks.push({
      type: 'table',
      caption: `Beam width at ${fmtLx(input.widthLevel)} lx`,
      columns: ['x', 'From y', 'To y', 'Width', 'Flags'],
      rows: result.widths.map((w) => [
        { text: fmtM(w.x, 2, true) },
        { text: fmtM(w.from) },
        { text: fmtM(w.to) },
        { text: w.width === null ? 'not reached' : fmtM(w.width, 2, true) },
        { text: [w.multiple ? 'separate areas' : '', w.clipped ? 'reaches the grid edge' : '', w.unknownAdjacent ? 'runs into unknown' : ''].filter(Boolean).join('; ') || '—' },
      ]),
    });
  }
  if (result.points.length) {
    blocks.push({
      type: 'table',
      caption: 'Illuminance at points',
      columns: ['Point', 'x, y, z (m)', 'Plane', 'E'],
      rows: result.points.map((p) => [
        { text: p.name },
        { text: p.point.map((v) => fmtM(v)).join(', ') },
        { text: !p.normal || (p.normal[2] === 1 && p.normal[0] === 0) ? 'road' : p.normal[0] === -1 ? 'vertical, facing the vehicle' : `normal ${p.normal.join(', ')}` },
        { text: Number.isNaN(p.value) ? 'no data (unknown)' : `${fmtLx(p.value)} lx` },
      ]),
    });
  }
  const rq = result.requirements;
  if (rq) {
    if (!rq.requirements.verified) {
      blocks.push({ type: 'notice', level: 'unverified', text: UNVERIFIED_NOTICE });
      unverified.push(SECTION_TITLES.road);
    }
    blocks.push({
      type: 'kv',
      rows: [
        ['Requirement file', `${rq.requirements.title} (id ${rq.requirements.id})`],
        ['Source', rq.requirements.source ?? 'not given'],
        ['Overall verdict', fmtStatus(rq.overall).toUpperCase()],
        ['Counts', `${rq.counts.pass} pass, ${rq.counts.fail} fail, ${rq.counts.notEvaluated} not evaluated`],
        ['Worst margin', rq.worst ?? '—'],
      ],
    });
    const v = (unit: 'lx' | 'm', x: number | null) => (x === null ? '—' : unit === 'lx' ? `${fmtLx(x)} lx` : fmtM(x, 2, true));
    blocks.push({
      type: 'table',
      caption: 'Requirements',
      columns: ['Requirement', 'Type', 'Measured', 'Limit', 'Margin', 'Margin %', 'Status', 'Flags / reason'],
      rows: rq.elements.map((e) => {
        if (e.status === 'not-evaluated') ne.push({ section: SECTION_TITLES.road, item: e.name, reason: e.reason ?? 'not evaluated' });
        return [
          { text: e.name },
          { text: e.type },
          { text: v(e.unit, e.measured) },
          { text: e.limit ? `${e.limit.kind} ${v(e.unit, e.limit.value)}` : '—' },
          { text: e.margin === null ? '—' : v(e.unit, e.margin) },
          { text: fmtPct(e.marginPercent, 1, true) },
          statusCell(e.status),
          { text: [...e.flags, e.reason].filter(Boolean).join('; ') || '—' },
        ];
      }),
    });
  }
  return blocks;
}

export const CONVENTIONS: Array<[string, string]> = [
  ['Angles', 'Type A, H-V, degrees. H positive to the right, V positive up, as seen from the lamp looking forward.'],
  ['Vehicle axes', 'x forward, y right, z up. Road: z = 0, origin on the ground below the vehicle front centre, lengths in metres.'],
  ['Yaw, pitch, roll', 'Yaw positive turns the beam right, pitch positive up, roll positive clockwise seen from the lamp. Applied as R = Yaw · Pitch · Roll (roll first). Rotations are true rotations on the sphere.'],
  ['Type B and C files', 'Converted to Type A on load. Their mapping onto vehicle axes is an assumption (docs/conventions.md); such files carry a warning.'],
  ['Interpolation', 'Bilinear in H and V on the dataset grid.'],
  ['Outside coverage', 'Directions without data are "no data" (NaN), never zero. Regulation elements touching them are "not evaluated". Road points they affect are unknown unless the treat-as-zero option is set.'],
  ['Status', '✓ pass, ✗ fail, – not evaluated. Not evaluated never counts as a pass.'],
];

export function buildReport(input: ReportInput): Report {
  const o = input.options;
  const notEvaluated: Report['notEvaluated'] = [];
  const unverified: string[] = [];
  const sections: ReportSection[] = [];
  const add = (id: SectionId, blocks: Block[]) => sections.push({ id, title: o.title && id === 'header' ? o.title : SECTION_TITLES[id], blocks });

  if (o.sections.header) {
    add('header', [
      {
        type: 'kv',
        rows: [
          ['Tool', `beamLab ${input.appVersion}`],
          ['Generated', input.generated],
          ...(o.author ? [['Author', o.author] as [string, string]] : []),
        ],
      },
      ...(o.notes ? [{ type: 'text', text: o.notes, pre: true } as Block] : []),
    ]);
  }
  if (o.sections.files) {
    add('files', input.datasets.length ? input.datasets.flatMap(fileIdentity) : [{ type: 'text', text: 'No datasets used.' }]);
  }
  if (o.sections.provenance) {
    add('provenance', input.evaluated ? [{ type: 'text', text: provenanceChain(input.evaluated), pre: true }] : [{ type: 'text', text: 'No dataset evaluated.' }]);
  }
  if (o.sections.regulation) {
    add('regulation', input.regulation ? regulationSection(input.regulation, notEvaluated, unverified) : [{ type: 'text', text: 'No regulation check was run.' }]);
  }
  if (o.sections.cutoff) {
    add('cutoff', input.cutoff ? cutoffSection(input.cutoff, notEvaluated) : [{ type: 'text', text: 'No cut-off analysis.' }]);
  }
  if (o.sections.road) {
    add('road', input.road ? roadSection(input.road, notEvaluated, unverified) : [{ type: 'text', text: 'No road calculation.' }]);
  }
  if (o.sections.conventions) {
    add('conventions', [{ type: 'kv', rows: CONVENTIONS }]);
  }
  return {
    meta: { tool: 'beamLab', version: input.appVersion, generated: input.generated, title: o.title, author: o.author, notes: o.notes },
    footer: REPORT_FOOTER,
    notEvaluated,
    unverified,
    sections,
  };
}
