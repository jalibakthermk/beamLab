import Plotly, { type PlotlyHTMLElement } from './plotly';
import type { AppState, Store } from './state/store';
import type { PhotometricDataset } from '../core/model/dataset';
import type { DatasetSummary } from '../core/analysis/summary';
import { displayGrid, type DisplayGrid } from '../core/analysis/display';
import { contourLines, toLineXY } from '../core/analysis/contours';
import { autoLevels, decadeTicks, parseLevels, type IntensityScale } from '../core/analysis/levels';
import { hSection, vSection, type Section } from '../core/analysis/section';
import { sample } from '../core/geometry/interpolate';
import { el } from './dom';
import { viridis, viridisScale } from './colors';
import { baseName, fmtCd, fmtDeg } from './format';

const OVERLAY_COLOR = '#ff2d87';
const MARKER_COLOR = '#e8590c';
const MAX_DISPLAY_PER_AXIS = 500;

// Display matrices are cached per dataset object and scale (display only).
const cache = new WeakMap<PhotometricDataset, Partial<Record<IntensityScale, DisplayGrid>>>();
function grid(ds: PhotometricDataset, scale: IntensityScale): DisplayGrid {
  const per = cache.get(ds) ?? {};
  per[scale] ??= displayGrid(ds, { scale, maxPerAxis: MAX_DISPLAY_PER_AXIS });
  cache.set(ds, per);
  return per[scale]!;
}

function themeColors() {
  const cs = getComputedStyle(document.documentElement);
  return {
    fg: cs.getPropertyValue('--fg').trim() || '#1d1d1b',
    muted: cs.getPropertyValue('--muted').trim() || '#6b6b66',
    grid: cs.getPropertyValue('--grid').trim() || '#d8d8d2',
    line: cs.getPropertyValue('--accent').trim() || '#3b528b',
  };
}

const toDisplayLevel = (cd: number, scale: IntensityScale) => (scale === 'log' ? Math.log10(cd) : cd);

// Contour polylines are cached per display grid and level (display only).
const lineCache = new WeakMap<DisplayGrid, Map<number, { x: (number | null)[]; y: (number | null)[] }>>();
function levelLines(g: DisplayGrid, level: number) {
  let per = lineCache.get(g);
  if (!per) lineCache.set(g, (per = new Map()));
  let xy = per.get(level);
  if (!xy) per.set(level, (xy = toLineXY(contourLines(g.h, g.v, g.z, level))));
  return xy;
}

interface PlotAxis {
  _offset: number;
  _length: number;
  p2c(px: number): number;
}

/** Converts a mouse event to data coordinates using Plotly's axis objects. */
function eventToData(plot: HTMLElement, e: MouseEvent): { h: number; v: number } | null {
  const fl = (plot as unknown as { _fullLayout?: { xaxis?: PlotAxis; yaxis?: PlotAxis } })._fullLayout;
  const xa = fl?.xaxis;
  const ya = fl?.yaxis;
  if (!xa || !ya) return null;
  const rect = plot.getBoundingClientRect();
  const px = e.clientX - rect.left - xa._offset;
  const py = e.clientY - rect.top - ya._offset;
  if (px < 0 || px > xa._length || py < 0 || py > ya._length) return null;
  return { h: xa.p2c(px), v: ya.p2c(py) };
}

export interface Viewer {
  render(state: AppState): void;
}

export function createViewer(root: HTMLElement, store: Store): Viewer {
  // ── Static skeleton ─────────────────────────────────────────────────
  const modeSel = el('select', { attrs: { 'aria-label': 'View' } }, [
    el('option', { text: 'Isocandela contours', attrs: { value: 'contour' } }),
    el('option', { text: 'False-colour map', attrs: { value: 'heatmap' } }),
  ]);
  const scaleSel = el('select', { attrs: { 'aria-label': 'Intensity scale' } }, [
    el('option', { text: 'Linear', attrs: { value: 'linear' } }),
    el('option', { text: 'Log', attrs: { value: 'log' } }),
  ]);
  const levelsSel = el('select', { attrs: { 'aria-label': 'Contour levels' } }, [
    el('option', { text: 'Auto levels', attrs: { value: 'auto' } }),
    el('option', { text: 'Custom levels', attrs: { value: 'custom' } }),
  ]);
  const levelsInput = el('input', {
    class: 'levels-input',
    attrs: { type: 'text', placeholder: 'e.g. 100 500 1000 5000 (cd)', 'aria-label': 'Custom contour levels in cd' },
  });
  const levelsMsg = el('span', { class: 'levels-msg', attrs: { role: 'status' } });
  const fitBtn = el('button', { class: 'btn', text: 'Fit to coverage' });
  const resetBtn = el('button', { class: 'btn', text: 'Reset view' });
  const pngBtn = el('button', { class: 'btn', text: 'PNG' });
  const plot = el('div', { class: 'main-plot' }) as unknown as PlotlyHTMLElement;
  const readout = el('div', { class: 'readout', attrs: { 'aria-live': 'off' } });
  const legend = el('div', { class: 'plot-legend' });
  const notice = el('div', { class: 'notice' });
  const secH = el('div', { class: 'section-plot' }) as unknown as PlotlyHTMLElement;
  const secV = el('div', { class: 'section-plot' }) as unknown as PlotlyHTMLElement;
  const secHint = el('p', { class: 'muted section-hint', text: 'Click the view to set a cross-section marker.' });
  const empty = el('div', { class: 'viewer-empty' }, [
    el('p', { text: 'No dataset selected.' }),
    el('p', { class: 'muted', text: 'Drop IES files anywhere on this page, or use “Open IES files…”.' }),
  ]);
  const body = el('div', { class: 'viewer-body' }, [
    el('div', { class: 'toolbar' }, [modeSel, scaleSel, levelsSel, levelsInput, fitBtn, resetBtn, pngBtn]),
    levelsMsg,
    el('p', { class: 'view-caption', text: 'As seen from the lamp, looking forward: H positive to the right, V positive up.' }),
    plot,
    el('div', { class: 'below-plot' }, [readout, legend]),
    notice,
    el('h3', { text: 'Cross-sections' }),
    secHint,
    el('div', { class: 'sections' }, [secH, secV]),
  ]);
  root.replaceChildren(el('h2', { text: 'Viewer', class: 'sr-only' }), empty, body);

  let current: { ds: PhotometricDataset; ov: PhotometricDataset | null; summary: DatasetSummary; name: string; ovName: string } | null = null;

  modeSel.addEventListener('change', () => store.setView({ mode: modeSel.value as 'contour' | 'heatmap' }));
  scaleSel.addEventListener('change', () => store.setView({ scale: scaleSel.value as IntensityScale }));
  levelsSel.addEventListener('change', () => {
    const mode = levelsSel.value as 'auto' | 'custom';
    if (mode === 'custom') applyCustom();
    else store.setView({ levelsMode: 'auto' });
  });
  const applyCustom = () => {
    const { levels, invalid } = parseLevels(levelsInput.value);
    levelsMsg.textContent = invalid.length ? `Ignored (not positive numbers): ${invalid.join(', ')}` : '';
    store.setView({ levelsMode: 'custom', customLevels: levels });
  };
  levelsInput.addEventListener('change', applyCustom);
  levelsInput.addEventListener('keydown', (e) => e.key === 'Enter' && applyCustom());
  fitBtn.addEventListener('click', () => {
    if (!current) return;
    const c = current.ds.coverage;
    void Plotly.relayout(plot, { 'xaxis.range': [c.hMin, c.hMax], 'yaxis.range': [c.vMin, c.vMax] });
  });
  resetBtn.addEventListener('click', () => {
    void Plotly.relayout(plot, { 'xaxis.autorange': true, 'yaxis.autorange': true });
  });
  pngBtn.addEventListener('click', () => {
    if (!current) return;
    const mode = store.getState().view.mode === 'contour' ? 'isocandela' : 'false-colour';
    void Plotly.downloadImage(plot, {
      format: 'png',
      filename: `${baseName(current.name)}-${mode}`,
      width: plot.clientWidth,
      height: plot.clientHeight,
    });
  });

  // ── Read-out (full-resolution sample(), not the plot's interpolation) ─
  const showReadout = (p: { h: number; v: number } | null) => {
    if (!current || !p) {
      readout.textContent = 'Move the pointer over the view for H, V and intensity.';
      return;
    }
    const i = sample(current.ds, p.h, p.v);
    let text = `H ${fmtDeg(p.h)}   V ${fmtDeg(p.v)}   I ${Number.isFinite(i) ? `${fmtCd(i)} cd` : 'no data'}`;
    if (current.ov) {
      const j = sample(current.ov, p.h, p.v);
      text += `   overlay ${Number.isFinite(j) ? `${fmtCd(j)} cd` : 'no data'}`;
    }
    readout.textContent = text;
  };
  plot.addEventListener('mousemove', (e) => showReadout(eventToData(plot, e)));
  plot.addEventListener('mouseleave', () => showReadout(null));

  // ── Click (not drag) sets the cross-section marker ──────────────────
  let down: { x: number; y: number } | null = null;
  plot.addEventListener('pointerdown', (e) => (down = { x: e.clientX, y: e.clientY }), true);
  // Plotly captures pointerup on its own drag cover, but 'click' still reaches the plot.
  plot.addEventListener(
    'click',
    (e) => {
      if (!down || !current) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      down = null;
      if (moved > 4) return;
      const p = eventToData(plot, e);
      if (p) store.setMarker(p);
    },
    true,
  );

  const sectionFigure = (
    s: Section,
    o: Section | null,
    markerAt: number,
    scale: IntensityScale,
    names: { ds: string; ov: string },
  ) => {
    const c = themeColors();
    const y = (vals: number[]) => vals.map((x) => (Number.isFinite(x) && (scale === 'linear' || x > 0) ? x : null));
    const data: object[] = [
      { type: 'scatter', mode: 'lines', x: s.angles, y: y(s.values), name: names.ds, line: { color: c.line, width: 1.5 } },
    ];
    if (o) {
      data.push({ type: 'scatter', mode: 'lines', x: o.angles, y: y(o.values), name: names.ov, line: { color: OVERLAY_COLOR, width: 1.5, dash: 'dash' } });
    }
    const other = s.axis === 'H' ? 'V' : 'H';
    return {
      data,
      layout: {
        title: { text: `I vs ${s.axis} at ${other} = ${fmtDeg(s.at)}`, font: { size: 13 } },
        margin: { l: 60, r: 10, t: 34, b: 40 },
        height: 230,
        showlegend: false,
        paper_bgcolor: 'rgba(0,0,0,0)',
        plot_bgcolor: 'rgba(0,0,0,0)',
        font: { color: c.fg, size: 11 },
        xaxis: { title: { text: `${s.axis} (°)` }, gridcolor: c.grid, zeroline: false },
        yaxis: { title: { text: 'cd' }, type: scale === 'log' ? 'log' : 'linear', gridcolor: c.grid, rangemode: scale === 'linear' ? 'tozero' : 'normal' },
        shapes: [
          { type: 'line', xref: 'x', yref: 'paper', x0: markerAt, x1: markerAt, y0: 0, y1: 1, line: { color: MARKER_COLOR, width: 1, dash: 'dot' } },
        ],
        hovermode: 'x',
      },
    };
  };

  return {
    render(state) {
      const entry = state.entries.find((e) => e.key === state.selectedKey);
      const ovEntry = state.entries.find((e) => e.key === state.overlayKey);
      if (!entry?.dataset || !entry.summary) {
        current = null;
        empty.hidden = false;
        body.hidden = true;
        Plotly.purge(plot);
        Plotly.purge(secH);
        Plotly.purge(secV);
        return;
      }
      empty.hidden = true;
      body.hidden = false;
      const ds = entry.dataset;
      const ov = ovEntry?.dataset ?? null;
      const view = state.view;
      current = { ds, ov, summary: entry.summary, name: entry.name, ovName: ovEntry?.name ?? '' };
      const c = themeColors();

      modeSel.value = view.mode;
      scaleSel.value = view.scale;
      levelsSel.value = view.levelsMode;
      levelsInput.hidden = view.levelsMode !== 'custom';
      if (view.levelsMode === 'auto') levelsMsg.textContent = '';

      const dg = grid(ds, view.scale);
      const og = ov ? grid(ov, view.scale) : null;
      let levels = view.levelsMode === 'custom' ? view.customLevels : [];
      if (!levels.length) {
        levels = autoLevels(entry.summary.maxIntensity, view.scale);
        if (view.levelsMode === 'custom') levelsMsg.textContent ||= 'No custom levels entered; showing automatic levels.';
      }
      const lv = levels.map((l) => toDisplayLevel(l, view.scale));

      const data: object[] = [];
      if (view.mode === 'heatmap') {
        const zmax = dg.zmax;
        const zmin = view.scale === 'log' ? Math.max(dg.zmin, zmax - 5) : Math.min(0, dg.zmin);
        const colorbar: Record<string, unknown> = { title: { text: 'cd' }, thickness: 14 };
        if (view.scale === 'log') {
          const ticks = decadeTicks(10 ** zmin, 10 ** zmax);
          colorbar['tickvals'] = ticks.map(Math.log10);
          colorbar['ticktext'] = ticks.map(fmtCd);
        }
        data.push({
          type: 'heatmap', x: dg.h, y: dg.v, z: dg.z, colorscale: 'Viridis', zmin, zmax, zauto: false,
          zsmooth: false, hoverinfo: 'skip', colorbar, name: entry.name,
        });
      } else {
        // Each level gets its own colour from Viridis (truncated so lines stay visible on white);
        // a hidden marker trace carries the colour bar, labelled with the levels in cd.
        const END = 0.85;
        const zmin = lv.length ? lv[0]! : 0;
        const zmax = lv.length > 1 ? lv[lv.length - 1]! : zmin + 1;
        lv.forEach((l, i) => {
          const t = lv.length > 1 ? (l - zmin) / (zmax - zmin) : 1;
          const { x, y } = levelLines(dg, l);
          data.push({
            type: 'scatter', mode: 'lines', x, y, line: { color: viridis(t * END), width: 1.6 },
            hoverinfo: 'skip', showlegend: false, name: `${fmtCd(levels[i]!)} cd`,
          });
        });
        if (lv.length) {
          data.push({
            type: 'scatter', mode: 'markers', x: [null], y: [null], hoverinfo: 'skip', showlegend: false,
            marker: {
              color: [zmin], cmin: zmin, cmax: zmax, colorscale: viridisScale(END), showscale: true,
              colorbar: { title: { text: 'cd' }, tickvals: lv, ticktext: levels.map(fmtCd), thickness: 14 },
            },
          });
        }
      }
      if (og) {
        for (const l of lv) {
          const { x, y } = levelLines(og, l);
          data.push({
            type: 'scatter', mode: 'lines', x, y, line: { color: OVERLAY_COLOR, width: 1.6, dash: 'dash' },
            hoverinfo: 'skip', showlegend: false,
          });
        }
      }
      const cov = ds.coverage;
      data.push({
        type: 'scatter', mode: 'lines', hoverinfo: 'skip', showlegend: false,
        x: [cov.hMin, cov.hMax, cov.hMax, cov.hMin, cov.hMin],
        y: [cov.vMin, cov.vMin, cov.vMax, cov.vMax, cov.vMin],
        line: { color: c.muted, width: 1, dash: 'dot' },
      });

      const m = view.marker;
      const layout = {
        uirevision: entry.key,
        margin: { l: 60, r: 20, t: 10, b: 50 },
        paper_bgcolor: 'rgba(0,0,0,0)',
        plot_bgcolor: 'rgba(0,0,0,0)',
        font: { color: c.fg, size: 12 },
        showlegend: false,
        hovermode: false,
        dragmode: 'zoom',
        xaxis: { title: { text: 'H (°)  → right' }, gridcolor: c.grid, zerolinecolor: c.muted, constrain: 'domain' },
        yaxis: { title: { text: 'V (°)  ↑ up' }, gridcolor: c.grid, zerolinecolor: c.muted, scaleanchor: 'x', scaleratio: 1, constrain: 'domain' },
        shapes: m
          ? [
              { type: 'line', xref: 'x', yref: 'paper', x0: m.h, x1: m.h, y0: 0, y1: 1, line: { color: MARKER_COLOR, width: 1 } },
              { type: 'line', xref: 'paper', yref: 'y', x0: 0, x1: 1, y0: m.v, y1: m.v, line: { color: MARKER_COLOR, width: 1 } },
            ]
          : [],
      };
      void Plotly.react(plot, data, layout, {
        responsive: true,
        displaylogo: false,
        scrollZoom: true,
        modeBarButtonsToRemove: ['select2d', 'lasso2d', 'toImage', 'autoScale2d'],
      });

      legend.replaceChildren(
        ...[
          el('span', { class: 'leg leg-solid', text: entry.name }),
          ov ? el('span', { class: 'leg leg-dash', text: `${ovEntry!.name} (overlay)` }) : null,
          el('span', { class: 'leg leg-cov', text: 'data coverage' }),
        ].filter((n): n is HTMLSpanElement => n !== null),
      );
      const notes: string[] = [];
      if (dg.downsampled || og?.downsampled) {
        const every = (n: number) => (n === 1 ? 'every' : `every ${n}${n === 2 ? 'nd' : n === 3 ? 'rd' : 'th'}`);
        notes.push(
          `Display downsampled for speed: drawing ${every(dg.stride.h)} H and ${every(dg.stride.v)} V grid line${og?.downsampled ? ' (overlay downsampled too)' : ''}. Read-out, sections and exports use the full data.`,
        );
      }
      if (view.scale === 'log' && dg.floor !== null) {
        notes.push(`Log scale: values ≤ 0 are drawn at ${fmtCd(dg.floor)} cd (display only).`);
      }
      notes.push('Areas without data are left empty.');
      notice.textContent = notes.join(' ');
      showReadout(null);

      if (m) {
        secHint.hidden = true;
        const names = { ds: entry.name, ov: ovEntry?.name ?? '' };
        const fh = sectionFigure(hSection(ds, m.v), ov ? hSection(ov, m.v) : null, m.h, view.scale, names);
        const fv = sectionFigure(vSection(ds, m.h), ov ? vSection(ov, m.h) : null, m.v, view.scale, names);
        const cfg = { responsive: true, displaylogo: false, modeBarButtonsToRemove: ['select2d', 'lasso2d'] };
        void Plotly.react(secH, fh.data, fh.layout, cfg);
        void Plotly.react(secV, fv.data, fv.layout, cfg);
      } else {
        secHint.hidden = false;
        Plotly.purge(secH);
        Plotly.purge(secV);
      }
    },
  };
}
