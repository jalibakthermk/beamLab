import Plotly, { type PlotlyHTMLElement } from './plotly';
import type { AppState, Store } from './state/store';
import type { PhotometricDataset } from '../core/model/dataset';
import { displayGrid, type DisplayGrid } from '../core/analysis/display';
import { contourLines, toLineXY } from '../core/analysis/contours';
import {
  decadeTicks,
  displayScaleFor,
  divergingRange,
  levelsForKind,
  parseLevels,
  ratioLogRange,
  valueRange,
  type IntensityScale,
} from '../core/analysis/levels';
import { hSection, vSection, type Section } from '../core/analysis/section';
import { sample } from '../core/geometry/interpolate';
import { subtract, OperationError } from '../core/ops/arithmetic';
import { el } from './dom';
import { baseName, fmtCd, fmtDeg, fmtValue, unitFor, type Kind } from './format';
import { DIVERGING, maskScale, NEGATIVE_LINE, POSITIVE_LINE, viridis, viridisScale } from './colors';

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

// Contour polylines are cached per display grid and level (display only).
const lineCache = new WeakMap<DisplayGrid, Map<number, { x: (number | null)[]; y: (number | null)[] }>>();
function levelLines(g: DisplayGrid, level: number) {
  let per = lineCache.get(g);
  if (!per) lineCache.set(g, (per = new Map()));
  let xy = per.get(level);
  if (!xy) per.set(level, (xy = toLineXY(contourLines(g.h, g.v, g.z, level))));
  return xy;
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

const toDisplay = (x: number, scale: IntensityScale) => (scale === 'log' ? Math.log10(x) : x);

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

interface Shown {
  ds: PhotometricDataset;
  kind: Kind;
  name: string;
  ov: PhotometricDataset | null;
  ovName: string;
  isPreview: boolean;
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
  const diffBtn = el('button', { class: 'btn', text: 'Show difference', title: 'Preview selected − overlay without adding it to the workspace' });
  const previewName = el('input', { class: 'name-input', attrs: { type: 'text', 'aria-label': 'Name for the new dataset' } });
  const previewBar = el('div', { class: 'preview-bar', attrs: { role: 'status' } });
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
    previewBar,
    el('div', { class: 'toolbar' }, [modeSel, scaleSel, levelsSel, levelsInput, fitBtn, resetBtn, pngBtn, diffBtn]),
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

  let current: Shown | null = null;

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
    const mode = store.getState().view.mode === 'contour' ? 'contours' : 'false-colour';
    void Plotly.downloadImage(plot, {
      format: 'png',
      filename: `${baseName(current.name)}-${mode}`,
      width: plot.clientWidth,
      height: plot.clientHeight,
    });
  });
  diffBtn.addEventListener('click', () => {
    const st = store.getState();
    const a = st.entries.find((e) => e.key === st.selectedKey)?.dataset;
    const b = st.entries.find((e) => e.key === st.overlayKey)?.dataset;
    if (!a || !b) return;
    try {
      store.setPreview(subtract(a, b));
      levelsMsg.textContent = '';
    } catch (e) {
      levelsMsg.textContent = e instanceof OperationError ? `Cannot show the difference: ${e.message}` : String(e);
    }
  });

  // ── Read-out (full-resolution sample(), not the plot's interpolation) ─
  const showReadout = (p: { h: number; v: number } | null) => {
    if (!current || !p) {
      readout.textContent = 'Move the pointer over the view for H, V and the value there.';
      return;
    }
    let text = `H ${fmtDeg(p.h)}   V ${fmtDeg(p.v)}   ${fmtValue(current.kind, sample(current.ds, p.h, p.v))}`;
    if (current.ov) text += `   overlay ${fmtValue(current.ov.kind as Kind, sample(current.ov, p.h, p.v))}`;
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

  const sectionFigure = (s: Section, o: Section | null, markerAt: number, kind: Kind, logAxis: boolean, names: { ds: string; ov: string }) => {
    const c = themeColors();
    const y = (vals: number[]) => vals.map((x) => (Number.isFinite(x) && (!logAxis || x > 0) ? x : null));
    const data: object[] = [
      { type: 'scatter', mode: 'lines', x: s.angles, y: y(s.values), name: names.ds, line: { color: c.line, width: 1.5 } },
    ];
    if (o) data.push({ type: 'scatter', mode: 'lines', x: o.angles, y: y(o.values), name: names.ov, line: { color: OVERLAY_COLOR, width: 1.5, dash: 'dash' } });
    const other = s.axis === 'H' ? 'V' : 'H';
    const unit = unitFor(kind);
    const shapes: object[] = [
      { type: 'line', xref: 'x', yref: 'paper', x0: markerAt, x1: markerAt, y0: 0, y1: 1, line: { color: MARKER_COLOR, width: 1, dash: 'dot' } },
    ];
    if (kind === 'difference') shapes.push({ type: 'line', xref: 'paper', yref: 'y', x0: 0, x1: 1, y0: 0, y1: 0, line: { color: c.fg, width: 1 } });
    if (kind === 'ratio') shapes.push({ type: 'line', xref: 'paper', yref: 'y', x0: 0, x1: 1, y0: 1, y1: 1, line: { color: c.fg, width: 1 } });
    return {
      data,
      layout: {
        title: { text: `${kind === 'intensity' ? 'I' : kind} vs ${s.axis} at ${other} = ${fmtDeg(s.at)}`, font: { size: 13 } },
        margin: { l: 60, r: 10, t: 34, b: 40 },
        height: 230,
        showlegend: false,
        paper_bgcolor: 'rgba(0,0,0,0)',
        plot_bgcolor: 'rgba(0,0,0,0)',
        font: { color: c.fg, size: 11 },
        xaxis: { title: { text: `${s.axis} (°)` }, gridcolor: c.grid, zeroline: false },
        yaxis: {
          title: { text: unit || kind },
          type: logAxis ? 'log' : 'linear',
          gridcolor: c.grid,
          rangemode: kind === 'intensity' && !logAxis ? 'tozero' : 'normal',
        },
        shapes,
        hovermode: 'x',
      },
    };
  };

  return {
    render(state) {
      const entry = state.entries.find((e) => e.key === state.selectedKey);
      const ovEntry = state.entries.find((e) => e.key === state.overlayKey);
      const previewDs = state.preview?.dataset ?? null;
      const ds = previewDs ?? entry?.dataset ?? null;
      if (!ds) {
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
      const kind = ds.kind as Kind;
      // An overlay is drawn only on a dataset of the same kind (contour levels must mean the same thing)
      const ovCandidate = ovEntry?.dataset ?? null;
      const ov = ovCandidate && ovCandidate.kind === ds.kind && ovCandidate !== ds ? ovCandidate : null;
      current = { ds, kind, name: ds.name, ov, ovName: ovEntry?.name ?? '', isPreview: !!previewDs };
      const view = state.view;
      const c = themeColors();

      // Preview banner
      previewBar.hidden = !previewDs;
      if (previewDs) {
        previewName.value = previewDs.name;
        previewBar.replaceChildren(
          el('strong', { text: 'Preview' }),
          el('span', { text: ` ${kindText(kind)}, not in the workspace yet. Name:` }),
          previewName,
          el('button', {
            class: 'btn primary',
            text: 'Create dataset',
            on: { click: () => store.addDerived(previewDs, previewName.value) },
          }),
          el('button', { class: 'btn', text: 'Close preview', on: { click: () => store.setPreview(null) } }),
        );
      }

      // Toolbar state
      const scale = displayScaleFor(kind, view.scale);
      modeSel.value = view.mode;
      scaleSel.value = scale;
      scaleSel.disabled = kind !== 'intensity';
      scaleSel.title = kind === 'intensity' ? '' : kind === 'ratio' ? 'Ratios are always shown on a log scale centred on 1' : 'Shown on a linear scale';
      levelsSel.value = kind === 'intensity' ? view.levelsMode : 'auto';
      levelsSel.disabled = kind !== 'intensity';
      levelsInput.hidden = kind !== 'intensity' || view.levelsMode !== 'custom';
      if (view.levelsMode === 'auto' && !levelsMsg.textContent?.startsWith('Cannot')) levelsMsg.textContent = '';
      // Offered only when A − B is allowed: both intensity or difference
      const signed = (k: string | undefined) => k === 'intensity' || k === 'difference';
      const ovSelected = !!ovEntry?.dataset && !!entry?.dataset && !previewDs && signed(entry.dataset.kind) && signed(ovEntry.dataset.kind);
      diffBtn.hidden = !ovSelected;
      diffBtn.textContent = ovSelected ? `Show difference (${entry!.name} − ${ovEntry!.name})` : 'Show difference';

      const dg = grid(ds, scale);
      const og = ov ? grid(ov, scale) : null;
      const range = valueRange(ds.values);
      let levels = kind === 'intensity' && view.levelsMode === 'custom' ? view.customLevels : [];
      if (!levels.length) {
        levels = levelsForKind(kind, range, scale);
        if (kind === 'intensity' && view.levelsMode === 'custom') levelsMsg.textContent ||= 'No custom levels entered; showing automatic levels.';
      }
      if (scale === 'log') levels = levels.filter((l) => l > 0);
      const lv = levels.map((l) => toDisplay(l, scale));

      const data: object[] = [];
      // Colour range and scale per kind
      let zmin: number;
      let zmax: number;
      let colorscale: unknown;
      const colorbar: Record<string, unknown> = { title: { text: unitFor(kind) || kind }, thickness: 14 };
      if (kind === 'difference') {
        ({ zmin, zmax } = divergingRange(range));
        colorscale = DIVERGING;
      } else if (kind === 'ratio') {
        ({ zmin, zmax } = ratioLogRange(range));
        colorscale = DIVERGING;
        const ticks = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100].filter((t) => Math.log10(t) >= zmin - 1e-9 && Math.log10(t) <= zmax + 1e-9);
        colorbar['tickvals'] = ticks.map(Math.log10);
        colorbar['ticktext'] = ticks.map(String);
        colorbar['title'] = { text: 'ratio' };
      } else if (kind === 'mask') {
        zmin = 0;
        zmax = 1;
        colorscale = maskScale(c.line);
        colorbar['tickvals'] = [0.25, 0.75];
        colorbar['ticktext'] = ['0 outside', '1 inside'];
        colorbar['title'] = { text: 'mask' };
      } else if (view.mode === 'heatmap') {
        zmax = dg.zmax;
        zmin = scale === 'log' ? Math.max(dg.zmin, zmax - 5) : Math.min(0, dg.zmin);
        colorscale = 'Viridis';
        if (scale === 'log') {
          const ticks = decadeTicks(10 ** zmin, 10 ** zmax);
          colorbar['tickvals'] = ticks.map(Math.log10);
          colorbar['ticktext'] = ticks.map(fmtCd);
        }
      } else {
        zmin = lv.length ? lv[0]! : 0;
        zmax = lv.length > 1 ? lv[lv.length - 1]! : zmin + 1;
        colorscale = viridisScale(0.85);
      }

      const heat = view.mode === 'heatmap' || kind === 'mask';
      if (heat) {
        data.push({
          type: 'heatmap', x: dg.h, y: dg.v, z: dg.z, colorscale, zmin, zmax, zauto: false,
          zsmooth: false, hoverinfo: 'skip', colorbar, name: ds.name,
        });
      }
      if (!heat || kind === 'mask') {
        // Contour lines computed in core, drawn as plain lines
        lv.forEach((l, i) => {
          const { x, y } = levelLines(dg, l);
          let color: string;
          let width = 1.6;
          if (kind === 'difference' || kind === 'ratio') {
            const centre = 0; // zero difference, or ratio 1 (log10 1 = 0)
            color = Math.abs(l - centre) < 1e-12 ? c.fg : l > centre ? POSITIVE_LINE : NEGATIVE_LINE;
            if (Math.abs(l - centre) < 1e-12) width = 2.6;
          } else if (kind === 'mask') {
            color = c.fg;
          } else {
            color = viridis((lv.length > 1 ? (l - zmin) / (zmax - zmin) : 1) * 0.85);
          }
          data.push({ type: 'scatter', mode: 'lines', x, y, line: { color, width }, hoverinfo: 'skip', showlegend: false, name: fmtValue(kind, levels[i]!) });
        });
        if (lv.length && kind !== 'mask') {
          const cb = { ...colorbar };
          if (kind === 'intensity') {
            cb['tickvals'] = lv;
            cb['ticktext'] = levels.map(fmtCd);
          } else if (kind === 'difference') {
            cb['tickvals'] = lv;
            cb['ticktext'] = levels.map((l) => (l > 0 ? `+${fmtCd(l)}` : fmtCd(l)));
          }
          data.push({
            type: 'scatter', mode: 'markers', x: [null], y: [null], hoverinfo: 'skip', showlegend: false,
            marker: { color: [zmin], cmin: zmin, cmax: zmax, colorscale, showscale: true, colorbar: cb },
          });
        }
      }
      if (og) {
        for (const l of lv) {
          const { x, y } = levelLines(og, l);
          data.push({ type: 'scatter', mode: 'lines', x, y, line: { color: OVERLAY_COLOR, width: 1.6, dash: 'dash' }, hoverinfo: 'skip', showlegend: false });
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
        uirevision: previewDs ? `preview:${entry?.key ?? ''}` : (entry?.key ?? ''),
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
          el('span', { class: 'leg leg-solid', text: `${ds.name}${previewDs ? ' (preview)' : ''}` }),
          ov ? el('span', { class: 'leg leg-dash', text: `${ovEntry!.name} (overlay)` }) : null,
          kind === 'difference' ? el('span', { class: 'leg leg-zero', text: 'zero line' }) : null,
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
      if (kind === 'intensity' && scale === 'log' && dg.floor !== null) notes.push(`Log scale: values ≤ 0 are drawn at ${fmtCd(dg.floor)} cd (display only).`);
      if (kind === 'difference') notes.push('Red: first dataset higher; blue: lower. The heavy line is zero.');
      if (kind === 'ratio') notes.push('Log colour scale centred on 1: red above 1, blue below. The heavy line is 1.');
      const article = (k: string) => (/^[aeiou]/.test(k) ? `an ${k}` : `a ${k}`);
      if (ovCandidate && !ov && ovCandidate !== ds) notes.push(`Overlay "${ovEntry!.name}" is hidden: it is ${article(ovCandidate.kind)}, this view shows ${article(kind)}.`);
      notes.push('Areas without data are left empty.');
      notice.textContent = notes.join(' ');
      showReadout(null);

      if (m) {
        secHint.hidden = true;
        const names = { ds: ds.name, ov: ovEntry?.name ?? '' };
        const logAxis = kind === 'intensity' && scale === 'log';
        const fh = sectionFigure(hSection(ds, m.v), ov ? hSection(ov, m.v) : null, m.h, kind, logAxis, names);
        const fv = sectionFigure(vSection(ds, m.h), ov ? vSection(ov, m.h) : null, m.v, kind, logAxis, names);
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

function kindText(kind: Kind): string {
  return kind === 'intensity' ? 'Intensity (cd)' : kind === 'difference' ? 'Difference (signed cd)' : kind === 'ratio' ? 'Ratio (no unit)' : 'Mask (0/1)';
}
