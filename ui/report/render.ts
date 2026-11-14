import Plotly from '../plotly';
import { el } from '../dom';
import { viridis, viridisScale } from '../colors';
import { decadeTicks } from '../../core/analysis/levels';
import { fmtLx } from '../../core/format';
import { UNVERIFIED_NOTICE, type Block, type PlotSpec, type Report } from '../../core/report/build';

/** Renders a report object as printable HTML (Phase 8). Display only. */

const PLOT_W = 680;
const PLOT_H = 360;
const STATUS_STYLE = {
  pass: { color: '#2b8a3e', dash: 'solid', label: '✓ pass' },
  fail: { color: '#c92a2a', dash: 'dash', label: '✗ fail' },
  'not-evaluated': { color: '#868e96', dash: 'dot', label: '– not evaluated' },
} as const;
const LEVEL_COLORS = ['#ff2d87', '#e8590c', '#f2c200', '#2b8a3e', '#1c7ed6', '#7048e8'];

const baseLayout = (title: string, x: string, y: string) => ({
  width: PLOT_W,
  height: PLOT_H,
  margin: { l: 58, r: 16, t: 36, b: 46 },
  title: { text: title, font: { size: 12 } },
  paper_bgcolor: '#ffffff',
  plot_bgcolor: '#ffffff',
  font: { color: '#1d1d1b', size: 11 },
  xaxis: { title: { text: x }, gridcolor: '#e3e3dd', zeroline: false },
  yaxis: { title: { text: y }, gridcolor: '#e3e3dd', zeroline: false },
  legend: { orientation: 'h', y: -0.2, font: { size: 10 } },
});

function figure(p: PlotSpec): { data: object[]; layout: object } {
  switch (p.kind) {
    case 'isocandela': {
      const n = Math.max(1, p.contours.length - 1);
      const data: object[] = p.contours.map((c, i) => ({ type: 'scatter', mode: 'lines', x: c.x, y: c.y, name: c.label, line: { color: viridis(0.1 + (0.8 * i) / n), width: 1.2 }, showlegend: false }));
      const shown = new Set<string>();
      for (const e of p.elements) {
        const st = STATUS_STYLE[e.status];
        data.push({
          type: 'scatter', mode: e.h.length === 1 ? 'markers' : 'lines', x: e.h, y: e.v, name: st.label, legendgroup: e.status, showlegend: !shown.has(e.status),
          line: { color: st.color, width: 1.6, dash: st.dash }, marker: { color: st.color, size: 7, symbol: e.status === 'pass' ? 'circle' : e.status === 'fail' ? 'x' : 'circle-open' },
          text: e.name, hoverinfo: 'text',
        });
        shown.add(e.status);
      }
      const l = baseLayout(p.title, 'H (°), + right', 'V (°), + up');
      return { data, layout: { ...l, xaxis: { ...l.xaxis, range: [p.h[0], p.h[p.h.length - 1]] }, yaxis: { ...l.yaxis, range: [p.v[0], p.v[p.v.length - 1]] } } };
    }
    case 'cutoff-scan': {
      const l = baseLayout(p.title, 'V (°)', 'log10 intensity (cd)');
      return {
        data: [
          { type: 'scatter', mode: 'lines', x: p.v, y: p.logI, name: 'log10 I', line: { color: '#3b528b', width: 1.6 } },
          { type: 'scatter', mode: 'lines', x: p.v, y: p.g, name: 'G (log10 per 0.1°)', yaxis: 'y2', line: { color: '#e8590c', width: 1.4, dash: 'dash' } },
        ],
        layout: {
          ...l,
          yaxis2: { title: { text: 'G' }, overlaying: 'y', side: 'right', zeroline: false, showgrid: false },
          shapes: p.cutoffV === null ? [] : [{ type: 'line', x0: p.cutoffV, x1: p.cutoffV, yref: 'paper', y0: 0, y1: 1, line: { color: '#1d1d1b', width: 1, dash: 'dot' } }],
          margin: { ...l.margin, r: 50 },
        },
      };
    }
    case 'cutoff-trace': {
      const seg = (s: Array<[number, number]>) => ({ x: s.map((q) => q[0]), y: s.map((q) => q[1]) });
      return {
        data: [
          { type: 'scatter', mode: 'markers', ...{ x: p.points.map((q) => q.h), y: p.points.map((q) => q.v) }, name: 'cut-off per H', marker: { color: '#3b528b', size: 5 } },
          { type: 'scatter', mode: 'lines', ...seg(p.horizontal), name: 'horizontal part', line: { color: '#2b8a3e', width: 2 } },
          { type: 'scatter', mode: 'lines', ...seg(p.shoulder), name: 'shoulder', line: { color: '#e8590c', width: 2, dash: 'dash' } },
          ...(p.elbow ? [{ type: 'scatter', mode: 'markers', x: [p.elbow.h], y: [p.elbow.v], name: 'elbow', marker: { color: '#1d1d1b', size: 9, symbol: 'diamond' } }] : []),
        ],
        layout: baseLayout(p.title, 'H (°), + right', 'cut-off V (°)'),
      };
    }
    case 'road': {
      const ticks = decadeTicks(10 ** p.zmin, 10 ** p.zmax);
      const data: object[] = [
        { type: 'heatmap', x: p.x, y: p.y, z: p.z, zmin: p.zmin, zmax: p.zmax, colorscale: viridisScale(1), zsmooth: false, colorbar: { title: { text: 'lx' }, tickvals: ticks.map(Math.log10), ticktext: ticks.map((t) => fmtLx(t)), thickness: 10 } },
        ...p.contours.map((c, i) => ({ type: 'scatter', mode: 'lines', x: c.x, y: c.y, name: c.label, line: { color: LEVEL_COLORS[i % LEVEL_COLORS.length], width: 1.8 } })),
        { type: 'scatter', mode: 'markers', x: p.lamps.map((q) => q.x), y: p.lamps.map((q) => q.y), name: 'lamps', marker: { color: '#1d1d1b', size: 6 } },
      ];
      const x0 = Math.min(p.x[0]!, -5);
      const x1 = p.x[p.x.length - 1]!;
      const l = baseLayout(p.title, 'x forward (m)', 'y (m), + right');
      return {
        data,
        layout: {
          ...l,
          xaxis: { ...l.xaxis, range: [x0, x1] },
          yaxis: { ...l.yaxis, range: [p.y[p.y.length - 1], p.y[0]] },
          shapes: [
            ...p.markings.map((m) => ({ type: 'line', x0, x1, y0: m.y, y1: m.y, line: { color: '#ffffff', width: m.kind === 'edge' ? 2 : 1.4, dash: m.kind === 'edge' ? 'solid' : 'dash' } })),
            { type: 'rect', x0: -4.5, x1: 0, y0: -0.9, y1: 0.9, line: { color: '#1d1d1b', width: 1.2 }, fillcolor: 'rgba(128,128,128,0.25)' },
          ],
        },
      };
    }
  }
}

function block(b: Block): HTMLElement {
  switch (b.type) {
    case 'kv':
      return el('table', { class: 'r-kv' }, [el('tbody', {}, b.rows.map(([k, v]) => el('tr', {}, [el('th', { text: k, attrs: { scope: 'row' } }), el('td', { text: v })])))]);
    case 'table':
      return el('table', { class: 'r-table' }, [
        el('caption', { text: b.caption }),
        el('thead', {}, [el('tr', {}, b.columns.map((c) => el('th', { text: c, attrs: { scope: 'col' } })))]),
        el('tbody', {}, b.rows.map((r) => el('tr', {}, r.map((c) => el('td', { text: c.text, ...(c.status ? { class: `st st-${c.status}` } : {}) }))))),
      ]);
    case 'notice':
      return el('p', { class: `r-notice r-${b.level}`, attrs: { role: b.level === 'unverified' ? 'alert' : 'note' }, text: `${b.level === 'unverified' ? '⚠ ' : 'ℹ '}${b.text}` });
    case 'text':
      return el(b.pre ? 'pre' : 'p', { class: b.pre ? 'r-pre' : 'r-text', text: b.text });
    case 'plot': {
      const div = el('div', { class: 'r-plot', attrs: { role: 'img', 'aria-label': b.plot.title } });
      const f = figure(b.plot);
      void Plotly.react(div, f.data, f.layout, { staticPlot: true, displayModeBar: false });
      return el('figure', { class: 'r-figure' }, [div, el('figcaption', { text: b.plot.title })]);
    }
  }
}

export function renderReport(root: HTMLElement, r: Report): void {
  const summary: HTMLElement[] = [];
  if (r.unverified.length) {
    summary.push(el('p', { class: 'r-notice r-unverified', attrs: { role: 'alert' }, text: `⚠ Unverified limits in: ${r.unverified.join(', ')}. ${UNVERIFIED_NOTICE}` }));
  }
  summary.push(
    r.notEvaluated.length
      ? el('div', { class: 'r-summary' }, [
          el('p', { text: `– Not evaluated (${r.notEvaluated.length}):` }),
          el('ul', {}, r.notEvaluated.map((x) => el('li', { text: `${x.section}: ${x.item} — ${x.reason}` }))),
        ])
      : el('p', { class: 'r-summary', text: 'Every item in the included sections was evaluated.' }),
  );
  const sections = r.sections.map((s, i) =>
    el('section', { class: `r-section r-${s.id}`, attrs: { 'aria-labelledby': `r-h-${s.id}` } }, [
      el(i === 0 && s.id === 'header' ? 'h1' : 'h2', { text: s.title, attrs: { id: `r-h-${s.id}` } }),
      ...s.blocks.map(block),
      ...(s.id === 'header' ? [el('h3', { text: 'Summary' }), ...summary] : []),
    ]),
  );
  if (r.sections[0]?.id !== 'header') sections.unshift(el('section', { class: 'r-section' }, [el('h2', { text: 'Summary' }), ...summary]));
  root.replaceChildren(...sections, el('footer', { class: 'r-footer', text: `${r.footer} beamLab ${r.meta.version}, ${r.meta.generated}.` }));
}
