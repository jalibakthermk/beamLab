import { describe, expect, it } from 'vitest';
import { parseIes } from '../core/io/ies';
import { aimToCutoff, cutoffVFromPercentDown, percentDownFromV } from '../core/ops/aim';
import { evaluateSharpness, scanCutoff, traceCutoff } from '../core/analysis/cutoff';
import { parseRegulation } from '../core/regs/schema';
import { evaluateWithAim } from '../core/regs/reaim';
import { lampPair, laneLayout, mirrorAim } from '../core/road/setup';
import { parseRequirements } from '../core/road/requirements';
import { runRoad } from '../core/road/results';
import { buildReport, DEFAULT_REPORT_OPTIONS, REPORT_FOOTER, UNVERIFIED_NOTICE, type Block, type ReportInput } from '../core/report/build';
import { fixture } from './load-fixture';
import testRegJson from './fixtures/regs/TEST-invented-values.json';

/**
 * End to end on synthetic fixtures (Phase 8): load → aim to cut-off → TEST
 * regulation → cut-off analysis → road calculation → report object.
 */

const name = 'cutoff-kink-rht.ies';
const parsed = parseIes(fixture(name), { name });
const loaded = parsed.dataset;
const target = cutoffVFromPercentDown(1);
const aimed = aimToCutoff(loaded, { targetV: target, scanH: -2, vMin: -3, vMax: 2, traffic: 'RHT', elbowAtZero: true, trace: { hMin: -8, hMax: 8, hStep: 0.5 }, timestamp: '2026-11-14T00:00:00.000Z' });
const reg = parseRegulation(testRegJson);
const evaluation = evaluateWithAim(aimed.dataset, reg, { mode: 'as-loaded' });
const cut = { scanH: -2, vMin: -3, vMax: 2, step: 0.05, traffic: 'RHT' as const, hMin: -8, hMax: 8, hStep: 0.5 };
const scan = scanCutoff(aimed.dataset, { h: cut.scanH, vMin: cut.vMin, vMax: cut.vMax, step: cut.step });
const trace = traceCutoff(aimed.dataset, { ...cut });
const sharpness = evaluateSharpness(scan.gMax, { min: null, max: null });
const aimL = { yaw: 0, pitch: 0, roll: 0 };
const roadInput = {
  lamps: lampPair({ left: aimed.dataset, right: null, mirror: 'none', separation: 1.4, height: 0.65, x: 0, aimLeft: aimL, aimRight: mirrorAim(aimL) }),
  grid: { x: { min: 0, max: 100, step: 1 }, y: { min: -10, max: 10, step: 0.5 } },
  outside: 'unknown' as const,
  levels: [1, 3],
  layout: laneLayout({ laneWidth: 3.5, lanes: 2, trafficSide: 'right', ownLane: 1, offset: 0 }),
  widthDistances: [25],
  widthLevel: 1,
  points: [{ name: 'P25', point: [25, 0, 0] as [number, number, number] }],
  // Test-only requirement values (invented), unverified
  requirements: parseRequirements({
    id: 'TEST-road', title: 'TEST ONLY: invented road values', source: null, revision: null, verified: false,
    elements: [
      { type: 'point', name: 'E at 25 m', x: 25, y: 0, z: 0, plane: 'road', min: 0.001 },
      { type: 'reach', name: 'Reach 1 lx', line: 'lane-centre', level: 1, min: null },
    ],
  }),
};
const road = runRoad(roadInput);

const input = (options = DEFAULT_REPORT_OPTIONS): ReportInput => ({
  options,
  appVersion: '1.0.0',
  generated: '2026-11-14T12:00:00.000Z',
  datasets: [{ name, sha256: 'ab'.repeat(32), origin: 'file', roles: ['evaluated', 'road lamps'], dataset: loaded, warnings: parsed.warnings, flipH: false }],
  evaluated: aimed.dataset,
  regulation: { reg, evaluation, aimModeLabel: 'As loaded' },
  cutoff: { datasetName: aimed.dataset.name, settings: { ...cut, presetTitle: null }, scan, trace, sharpness, dataset: aimed.dataset },
  road: { input: roadInput, result: road, layout: roadInput.layout, requirementsVerified: false },
});

const kv = (blocks: Block[]) => new Map(blocks.flatMap((b) => (b.type === 'kv' ? b.rows : [])));
const tables = (blocks: Block[]) => blocks.filter((b): b is Extract<Block, { type: 'table' }> => b.type === 'table');

describe('end to end: load, aim, regulation, cut-off, road, report', () => {
  it('the pipeline produces the expected intermediate results', () => {
    expect(aimed.converged).toBe(true);
    expect(percentDownFromV(scan.v)).toBeCloseTo(1, 1);
    expect(trace.fit!.elbow.h).toBeCloseTo(0, 1);
    expect(evaluation.result.elements.length).toBe(reg.elements.length);
    expect(road.field.values.length).toBe(101 * 41);
  });

  const report = buildReport(input());
  const section = (id: string) => report.sections.find((s) => s.id === id)!;

  it('has every section in order, the footer and the header', () => {
    expect(report.sections.map((s) => s.id)).toEqual(['header', 'files', 'provenance', 'regulation', 'cutoff', 'road', 'conventions']);
    expect(report.footer).toBe(REPORT_FOOTER);
    expect(report.footer).toBe('Engineering assessment generated locally. Not a type-approval document.');
    expect(kv(section('header').blocks).get('Tool')).toBe('beamLab 1.0.0');
  });

  it('file identity: hash, format, type, step, range, peak, flux, warnings', () => {
    const rows = kv(section('files').blocks);
    expect(rows.get('SHA-256')).toBe('ab'.repeat(32));
    expect(rows.get('Format version')).toBe('LM-63-2002');
    expect(rows.get('Photometric type')).toBe('Type A');
    expect(rows.get('Grid step')).toMatch(/^H .*°, V .*°$/);
    expect(rows.get('Peak')).toMatch(/cd at H/);
    expect(rows.get('Flux (covered range)')).toMatch(/lm$/);
    expect(section('files').blocks.some((b) => b.type === 'text' && b.text.startsWith('Parser warnings') || b.type === 'table')).toBe(true);
  });

  it('provenance names the aim operation and the source file', () => {
    const t = section('provenance').blocks[0]!;
    expect(t.type === 'text' && t.text).toContain(name);
    expect(t.type === 'text' && t.text).toMatch(/aim|rotat/i);
  });

  it('regulation: identity, conditions, unverified notice, full results table, verdict, plot with elements', () => {
    const b = section('regulation').blocks;
    const rows = kv(b);
    expect(rows.get('Regulation')).toContain('TEST-invented-values');
    expect(rows.get('Revision')).toBe('test');
    expect(rows.get('Traffic side')).toBe('right-hand traffic');
    expect(rows.get('Aim mode')).toBe('As loaded');
    expect(rows.get('Test conditions')).toContain('1 lamp(s)');
    expect(rows.get('Overall verdict')).toMatch(/PASS|FAIL|INCOMPLETE/);
    expect(b.find((x) => x.type === 'notice')).toEqual({ type: 'notice', level: 'unverified', text: UNVERIFIED_NOTICE });
    const t = tables(b)[0]!;
    expect(t.rows.length).toBe(reg.elements.length);
    expect(t.rows.find((r) => r[0]!.text === 'NoLimit')![6]).toEqual({ text: '– not evaluated', status: 'not-evaluated' });
    const plot = b.find((x) => x.type === 'plot')!;
    expect(plot.type === 'plot' && plot.plot.kind === 'isocandela' && plot.plot.elements.length).toBeGreaterThan(5);
  });

  it('cut-off: settings, summary at 1 % down, scan and trace plots', () => {
    const b = section('cutoff').blocks;
    expect(kv(b).get('Vertical scan')).toBe('H -2°, V -3° to 2°, step 0.05°');
    const summary = tables(b)[0]!;
    expect(summary.rows.find((r) => r[0]!.text === 'Cut-off V')![1]!.text).toMatch(/\(1\.0\d% down\)/);
    expect(b.filter((x) => x.type === 'plot').map((x) => x.type === 'plot' && x.plot.kind)).toEqual(['cutoff-scan', 'cutoff-trace']);
  });

  it('road: lamps, lanes, plot, reach, width, points and the requirement table with its notice', () => {
    const b = section('road').blocks;
    expect(tables(b)[0]!.rows.length).toBe(2);
    expect(kv(b).get('Lanes')).toContain('lane width 3.50 m');
    expect(b.some((x) => x.type === 'plot' && x.plot.kind === 'road')).toBe(true);
    const caps = tables(b).map((t) => t.caption);
    expect(caps).toEqual(['Lamps', 'Reach of the isolux levels', 'Beam width at 1.00 lx', 'Illuminance at points', 'Requirements']);
    expect(b.filter((x) => x.type === 'notice' && x.level === 'unverified').length).toBe(1);
  });

  it('lists every not-evaluated item at the top, and the sections with unverified limits', () => {
    const items = report.notEvaluated.map((x) => `${x.section}: ${x.item}`);
    expect(items).toContain('Regulation check: NoLimit');
    expect(items).toContain('Road performance: Reach 1 lx');
    expect(items).toContain('Cut-off analysis: Sharpness (Gmax)');
    expect(report.unverified).toEqual(['Regulation check', 'Road performance']);
  });

  it('chosen sections only; title, author and notes in the header', () => {
    const r = buildReport(input({ ...DEFAULT_REPORT_OPTIONS, title: 'Lamp X', author: 'A. Tester', notes: 'line 1\nline 2', sections: { ...DEFAULT_REPORT_OPTIONS.sections, files: false, road: false, cutoff: false } }));
    expect(r.sections.map((s) => s.id)).toEqual(['header', 'provenance', 'regulation', 'conventions']);
    expect(r.sections[0]!.title).toBe('Lamp X');
    expect(kv(r.sections[0]!.blocks).get('Author')).toBe('A. Tester');
    expect(r.notEvaluated.every((x) => x.section === 'Regulation check')).toBe(true);
    expect(r.unverified).toEqual(['Regulation check']);
  });

  it('the report object is plain data (serialisable)', () => {
    const json = JSON.stringify(report);
    expect(json.length).toBeGreaterThan(1000);
    expect(JSON.parse(json).footer).toBe(REPORT_FOOTER);
  });
});
