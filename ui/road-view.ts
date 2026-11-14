import Plotly from './plotly';
import type { AppState, Store } from './state/store';
import { el } from './dom';
import { viridisScale } from './colors';
import { contourLines, toLineXY } from '../core/analysis/contours';
import { decadeTicks } from '../core/analysis/levels';
import { makeEvaluator } from '../core/road/illuminance';
import { prepare, runState } from './road-run';
import { fmtLx, fmtM, fmtPct } from './format';
import { requirementEntry } from './road';
import type { RoadRunResult } from '../core/road/results';

/**
 * Road view: top view of the road (x forward to the right, y right downwards,
 * as seen from above), false-colour illuminance on a log scale, isolux
 * contours, lane markings and a schematic vehicle outline. Display only: all
 * numbers come from core/road.
 */

const LEVEL_COLORS = ['#ff2d87', '#e8590c', '#f2c200', '#2b8a3e', '#1c7ed6', '#7048e8'];

interface PlotAxis {
  _offset: number;
  _length: number;
  p2c(px: number): number;
}

function themeColors() {
  const cs = getComputedStyle(document.documentElement);
  return { fg: cs.getPropertyValue('--fg').trim() || '#1d1d1b', muted: cs.getPropertyValue('--muted').trim() || '#6b6b66', grid: cs.getPropertyValue('--grid').trim() || '#d8d8d2' };
}

// Display matrix (log10 lx, null where unknown or ≤ 0) and contours, cached per result.
const cache = new WeakMap<RoadRunResult, { z: (number | null)[][]; raw: (number | null)[][]; lines: Map<number, { x: (number | null)[]; y: (number | null)[] }> }>();
function display(r: RoadRunResult) {
  let c = cache.get(r);
  if (!c) {
    const f = r.field;
    const nc = f.cols.length;
    const raw: (number | null)[][] = [];
    const z: (number | null)[][] = [];
    for (let i = 0; i < f.rows.length; i++) {
      const rr: (number | null)[] = [];
      const zr: (number | null)[] = [];
      for (let j = 0; j < nc; j++) {
        const v = f.values[i * nc + j]!;
        rr.push(Number.isFinite(v) ? v : null);
        zr.push(Number.isFinite(v) && v > 0 ? Math.log10(v) : null);
      }
      raw.push(rr);
      z.push(zr);
    }
    cache.set(r, (c = { z, raw, lines: new Map() }));
  }
  return c;
}

export function createRoadView(root: HTMLElement, store: Store) {
  const equal = el('input', { attrs: { type: 'checkbox' } });
  equal.addEventListener('change', () => store.setRoad({ equalAxes: equal.checked }));
  const plot = el('div', { class: 'main-plot road-plot' });
  const readout = el('div', { class: 'readout', attrs: { 'aria-live': 'polite' } });
  const caption = el('p', { class: 'view-caption' });
  const empty = el('div', { class: 'viewer-empty muted' });
  const legend = el('div', { class: 'plot-legend' });
  const body = el('div', {}, [
    el('div', { class: 'toolbar' }, [el('strong', { text: 'Road, top view' }), el('label', { class: 'check' }, [equal, el('span', { text: 'Equal scale on both axes' })])]),
    caption,
    plot,
    el('div', { class: 'below-plot' }, [readout, legend]),
  ]);
  root.replaceChildren(empty, body);

  let evaluate: ((p: [number, number, number]) => number) | null = null;
  let shownFor: RoadRunResult | null = null;
  let equalShown: boolean | null = null;

  plot.addEventListener('mousemove', (e) => {
    const fl = (plot as unknown as { _fullLayout?: { xaxis?: PlotAxis; yaxis?: PlotAxis } })._fullLayout;
    const xa = fl?.xaxis;
    const ya = fl?.yaxis;
    if (!xa || !ya || !evaluate) return;
    const rect = plot.getBoundingClientRect();
    const px = e.clientX - rect.left - xa._offset;
    const py = e.clientY - rect.top - ya._offset;
    if (px < 0 || px > xa._length || py < 0 || py > ya._length) {
      readout.textContent = '';
      return;
    }
    const x = xa.p2c(px);
    const y = ya.p2c(py);
    const v = evaluate([x, y, 0]);
    const side = Math.abs(y) < 0.005 ? 'centre' : y > 0 ? 'right' : 'left';
    readout.textContent = `x ${fmtM(x, 2, true)}, y ${fmtM(y, 2, true)} (${side}): ${Number.isNaN(v) ? 'no data (unknown)' : `${fmtLx(v)} lx`}`;
  });
  plot.addEventListener('mouseleave', () => (readout.textContent = ''));

  return {
    render(state: AppState) {
      equal.checked = state.road.equalAxes;
      const run = runState();
      const prep = prepare(state, requirementEntry(state)?.req ?? null);
      const r = prep.input && !run.running ? run.result : null;
      if (!r || !run.input) {
        empty.hidden = false;
        body.hidden = true;
        empty.textContent = prep.input ? (run.error ? run.error : 'Calculating…') : 'Enter the lamps on the Road tab to see the road illuminance.';
        Plotly.purge(plot);
        shownFor = null;
        evaluate = null;
        return;
      }
      empty.hidden = true;
      body.hidden = false;
      if (shownFor === r && equalShown === state.road.equalAxes) return;
      shownFor = r;
      equalShown = state.road.equalAxes;
      const input = run.input;
      evaluate = makeEvaluator(input.lamps, { outside: input.outside });
      const c = themeColors();
      const d = display(r);
      const f = r.field;

      // Log colour range: 4 decades below the maximum, extended down to the lowest isolux level
      const zmax = r.max && r.max.value > 0 ? Math.log10(r.max.value) : 1;
      const lowest = input.levels.length ? Math.log10(input.levels[0]!) - 0.5 : zmax - 4;
      const zmin = Math.min(zmax - 4, lowest);
      const ticks = decadeTicks(10 ** zmin, 10 ** zmax);
      const data: object[] = [
        {
          type: 'heatmap', x: f.cols, y: f.rows, z: d.z, zmin, zmax, colorscale: viridisScale(1), hoverinfo: 'skip', zsmooth: false,
          colorbar: { title: { text: 'lx', side: 'right' }, tickvals: ticks.map(Math.log10), ticktext: ticks.map((t) => fmtLx(t)), thickness: 12 },
        },
      ];
      input.levels.forEach((lv, i) => {
        let xy = d.lines.get(lv);
        if (!xy) d.lines.set(lv, (xy = toLineXY(contourLines(f.cols, f.rows, d.raw, lv))));
        data.push({ type: 'scatter', mode: 'lines', x: xy.x, y: xy.y, name: `${lv} lx`, line: { color: LEVEL_COLORS[i % LEVEL_COLORS.length], width: 2 }, hoverinfo: 'skip' });
      });

      // Lane markings and the schematic vehicle outline
      const xLo = Math.min(f.cols[0]!, -5);
      const xHi = f.cols[f.cols.length - 1]!;
      const shapes: object[] = [];
      for (const m of prep.layout?.markings ?? []) {
        shapes.push({ type: 'line', x0: xLo, x1: xHi, y0: m.y, y1: m.y, line: { color: '#ffffff', width: m.kind === 'edge' ? 2 : 1.5, dash: m.kind === 'edge' ? 'solid' : 'dash' }, layer: 'above' });
      }
      const half = Math.max(0.8, ...input.lamps.map((l) => Math.abs(l.position.y) + 0.15));
      shapes.push({ type: 'rect', x0: -4.5, x1: 0, y0: -half, y1: half, line: { color: c.fg, width: 1.5 }, fillcolor: 'rgba(128,128,128,0.25)', layer: 'above' });
      data.push({
        type: 'scatter', mode: 'markers', x: input.lamps.map((l) => l.position.x), y: input.lamps.map((l) => l.position.y),
        marker: { color: c.fg, size: 7, symbol: 'circle' }, name: 'lamps', hoverinfo: 'skip',
      });

      const layout = {
        margin: { l: 56, r: 10, t: 10, b: 44 },
        paper_bgcolor: 'rgba(0,0,0,0)',
        plot_bgcolor: 'rgba(0,0,0,0)',
        font: { color: c.fg, size: 12 },
        showlegend: false,
        xaxis: { title: { text: 'x forward (m)' }, range: [xLo, xHi], gridcolor: c.grid, zeroline: false },
        yaxis: {
          title: { text: 'y (m), + right' }, range: [f.rows[f.rows.length - 1]!, f.rows[0]!], gridcolor: c.grid, zeroline: false,
          ...(state.road.equalAxes ? { scaleanchor: 'x', scaleratio: 1 } : {}),
        },
        shapes,
        hovermode: false,
      };
      void Plotly.react(plot, data, layout, { displaylogo: false, responsive: true, modeBarButtonsToRemove: ['select2d', 'lasso2d'] });

      legend.replaceChildren(
        ...input.levels.map((lv, i) => {
          const s = el('span', { class: 'leg', text: `${lv} lx` });
          s.style.setProperty('--leg-color', LEVEL_COLORS[i % LEVEL_COLORS.length]!);
          s.classList.add('leg-level');
          return s;
        }),
        prep.layout ? el('span', { class: 'leg leg-lane', text: 'lane markings' }) : el('span', { class: 'muted', text: 'no lane setup' }),
      );
      caption.textContent = `${input.lamps.length} lamp(s). Log colour scale, lx. Empty areas: no data in that direction (unknown, ${fmtPct(f.unknownFraction * 100, 1)} of the grid)${input.outside === 'zero' ? '; set to 0 lx by the option' : ''}. Vehicle outline is schematic.`;
    },
  };
}
