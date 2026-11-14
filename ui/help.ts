import { el } from './dom';
import { APP_VERSION } from '../core/model/version';
import { CONVENTIONS } from '../core/report/build';

const REPO = 'https://github.com/jalibakthermk/beamLab/blob/main/';

/** In-app Help panel (Phase 8): short guide plus links to the documentation. */
export function createHelp(): { open(from: HTMLElement): void } {
  const dlg = el('dialog', { class: 'help-dialog', attrs: { 'aria-labelledby': 'help-title' } });
  const link = (file: string, text: string) => el('li', {}, [el('a', { text, attrs: { href: REPO + file, target: '_blank', rel: 'noopener' } })]);
  dlg.append(
    el('h2', { text: `beamLab ${APP_VERSION}: help`, attrs: { id: 'help-title' } }),
    el('p', { text: 'Files are processed locally in your browser. Nothing is uploaded.' }),
    el('h3', { text: 'Tabs' }),
    el('ul', { class: 'help-list' }, [
      el('li', { text: 'Info: summary, warnings with suggested actions, keywords, provenance, mirror (flip H), export as IES or CSV, probe a value.' }),
      el('li', { text: 'Evaluate: choose a regulation file, traffic side and aim mode; results table with margins; elements drawn in the viewer.' }),
      el('li', { text: 'Road: lamps, lanes and grid; road top view with isolux lines; reach, width, points and a requirements check.' }),
      el('li', { text: 'Manipulate: add, subtract, scale, multiply, divide, window, rotate; preview, then create a dataset.' }),
      el('li', { text: 'Cut-off: vertical scan, line trace and fit, aim to the cut-off.' }),
      el('li', { text: 'Report (header): printable report; Settings: export or import all settings as JSON (file names and SHA-256 only).' }),
    ]),
    el('h3', { text: 'Conventions' }),
    el('dl', { class: 'kv small' }, CONVENTIONS.flatMap(([k, v]) => [el('dt', { text: k }), el('dd', { text: v })])),
    el('h3', { text: 'Documentation' }),
    el('ul', { class: 'help-list' }, [link('README.md', 'README: overview and walkthrough'), link('docs/conventions.md', 'Conventions: axes, signs, interpolation, coverage'), link('docs/adding-a-regulation.md', 'Adding a regulation file'), link('CHANGELOG.md', 'Changelog')]),
    el('div', { class: 'btn-row' }, [el('button', { class: 'btn primary', text: 'Close', on: { click: () => dlg.close() } })]),
  );
  document.body.append(dlg);
  let back: HTMLElement | null = null;
  dlg.addEventListener('close', () => back?.focus());
  return {
    open(from) {
      back = from;
      dlg.showModal();
    },
  };
}
