import type { AppState, Entry } from '../state/store';
import type { PhotometricDataset } from '../../core/model/dataset';
import { buildReport, type Report, type ReportDataset, type ReportInput } from '../../core/report/build';
import { APP_VERSION } from '../../core/model/version';
import { currentEvaluation, MODE_LABEL, regulations } from '../evaluate';
import { analyse, cutoffSubjects } from '../cutoff';
import { prepare, runState } from '../road-run';
import { requirementEntry } from '../road';

/**
 * Gathers the current results into a ReportInput (Phase 8). The report object
 * itself is built in core/report/build.ts.
 */
export function reportInput(state: AppState, generated: string): ReportInput {
  const datasets = new Map<string, ReportDataset>();
  const use = (entry: Entry | undefined, role: string) => {
    if (!entry?.dataset) return;
    const d = datasets.get(entry.key) ?? { name: entry.name, sha256: entry.sha256, origin: entry.origin, roles: [], dataset: entry.dataset, warnings: entry.warnings, flipH: entry.flipH };
    if (!d.roles.includes(role)) d.roles.push(role);
    datasets.set(entry.key, d);
  };
  const byDataset = (ds: PhotometricDataset | null) => state.entries.find((e) => e.dataset === ds);
  const selected = state.entries.find((e) => e.key === state.selectedKey);

  // Regulation check (only if it belongs to what is shown now)
  const ev = currentEvaluation(state);
  const regEntry = ev ? regulations().find((r) => r.key === state.evaluate.regId) : undefined;
  const regulation = ev && regEntry ? { reg: regEntry.reg, evaluation: ev, aimModeLabel: MODE_LABEL[ev.mode] } : null;
  if (regulation) use(selected, 'regulation check');

  // Cut-off analysis of the dataset shown
  const { main } = cutoffSubjects(state);
  let cutoff: ReportInput['cutoff'] = null;
  if (main && state.report.sections.cutoff) {
    const a = analyse(main, state.cutoff);
    const s = a.settings;
    cutoff = {
      datasetName: main.name,
      settings: { scanH: s.scanH, vMin: s.vMin, vMax: s.vMax, step: s.step, traffic: s.traffic, hMin: s.hMin, hMax: s.hMax, hStep: s.hStep, presetTitle: s.preset?.title ?? null },
      scan: a.scan,
      trace: a.trace,
      sharpness: a.sharpness,
      dataset: main,
    };
    use(byDataset(main) ?? (state.preview ? byDataset(state.preview.compareTo) : undefined) ?? selected, 'cut-off analysis');
  }

  // Road calculation (only if its result belongs to the current inputs)
  const req = requirementEntry(state);
  const prep = prepare(state, req?.req ?? null);
  const run = runState();
  let road: ReportInput['road'] = null;
  if (prep.input && !run.running && run.result && run.input) {
    road = { input: run.input, result: run.result, layout: prep.layout, requirementsVerified: req ? req.req.verified : null };
    state.road.lamps.forEach((l, i) => use(state.entries.find((e) => e.key === l.entryKey), `road lamp ${i + 1}`));
  }

  const evaluated = ev?.dataset ?? state.preview?.dataset ?? selected?.dataset ?? null;
  if (!datasets.size && selected) use(selected, 'selected');
  return { options: state.report, appVersion: APP_VERSION, generated, datasets: [...datasets.values()], evaluated, regulation, cutoff, road };
}

export function currentReport(state: AppState): Report {
  return buildReport(reportInput(state, new Date().toISOString().replace(/\.\d+Z$/, 'Z')));
}
