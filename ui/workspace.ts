import type { AppState, Entry, Store } from './state/store';
import { el } from './dom';
import { fmtStep, fmtValue, type Kind } from './format';
import { provenanceChain } from '../core/model/provenance';

function badge(entry: Entry): HTMLElement | null {
  const warn = entry.warnings.filter((w) => w.severity === 'warning').length;
  const info = entry.warnings.length - warn;
  if (!entry.warnings.length) return null;
  return el('span', {
    class: warn ? 'badge badge-warn' : 'badge badge-info',
    text: warn ? `⚠ ${warn}` : `i ${info}`,
    title: `${warn} warning(s), ${info} info message(s). Details in the Info panel.`,
  });
}

export function renderWorkspace(root: HTMLElement, state: AppState, store: Store): void {
  const list = el('ul', { class: 'ds-list', attrs: { role: 'list' } });
  for (const e of state.entries) {
    const selected = e.key === state.selectedKey;
    if (!e.dataset) {
      list.append(
        el('li', { class: 'ds-row ds-error' }, [
          el('div', { class: 'ds-main' }, [
            el('span', { class: 'ds-name', text: e.name, title: e.name }),
            el('span', { class: 'ds-err', text: `Could not load: ${e.error ?? 'unknown error'}` }),
          ]),
          el('button', {
            class: 'icon-btn',
            text: '✕',
            title: `Remove ${e.name}`,
            attrs: { 'aria-label': `Remove ${e.name}` },
            on: { click: () => store.remove(e.key) },
          }),
        ]),
      );
      continue;
    }
    const s = e.summary!;
    const kind = e.dataset.kind as Kind;
    const overlayBox = el('input', {
      attrs: { type: 'checkbox', 'aria-label': `Overlay ${e.name}` },
      on: { change: (ev) => store.setOverlay((ev.target as HTMLInputElement).checked ? e.key : null) },
    });
    overlayBox.checked = e.key === state.overlayKey;
    overlayBox.disabled = selected;
    const peak = kind === 'mask' ? 'mask' : `max ${fmtValue(kind, s.maxIntensity)}`;
    list.append(
      el('li', { class: selected && !state.preview ? 'ds-row selected' : 'ds-row' }, [
        el(
          'button',
          {
            class: 'ds-main',
            attrs: { 'aria-pressed': String(selected), title: `Select ${e.name}` },
            on: { click: () => store.select(e.key) },
          },
          [
            el('span', { class: 'ds-name', text: e.name + (e.flipH ? ' (mirrored)' : '') }),
            el('span', { class: 'ds-meta' }, [
              el('span', { class: `kind kind-${kind}`, text: kind }),
              el('span', { text: peak }),
              el('span', { text: `step ${fmtStep(s.step.h)} × ${fmtStep(s.step.v)}` }),
              badge(e),
            ]),
          ],
        ),
        el('label', { class: 'ds-overlay', title: selected ? 'The selected dataset cannot be its own overlay' : 'Overlay on the selected dataset' }, [
          overlayBox,
          'Overlay',
        ]),
        el('button', {
          class: 'icon-btn',
          text: '✕',
          title: `Remove ${e.name}`,
          attrs: { 'aria-label': `Remove ${e.name}` },
          on: { click: () => store.remove(e.key) },
        }),
        el('details', { class: 'chain-details' }, [
          el('summary', { text: e.origin === 'derived' ? 'Provenance chain' : 'Provenance' }),
          el('pre', { class: 'chain', text: provenanceChain(e.dataset) }),
        ]),
      ]),
    );
  }
  root.replaceChildren(
    el('h2', { text: 'Workspace' }),
    state.entries.length
      ? list
      : el('div', { class: 'dropzone' }, [
          el('p', { text: 'Drop IES files here' }),
          el('p', { class: 'muted', text: 'or use “Open IES files…” above. Several files at once are fine.' }),
        ]),
  );
}
