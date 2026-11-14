import type { Store } from '../state/store';
import { el } from '../dom';
import { busy } from '../busy';
import { currentReport } from './collect';
import { renderReport } from './render';
import { SECTION_IDS, SECTION_TITLES, type SectionId } from '../../core/report/build';
import { messageText, toUserMessage } from '../../core/messages';

/**
 * Report page (Phase 8): options (not printed) and the report. The browser's
 * print dialog turns it into a PDF (A4, see the print rules in styles.css).
 */
export function createReportPage(store: Store) {
  const root = el('div', { class: 'report-page', attrs: { id: 'report-root', role: 'region', 'aria-label': 'Report' } });
  root.hidden = true;
  document.body.append(root);
  const controls = el('div', { class: 'report-controls' });
  const paper = el('article', { class: 'report-paper' });
  root.append(controls, paper);
  let open = false;
  let opener: HTMLElement | null = null;

  const close = () => {
    open = false;
    root.hidden = true;
    document.body.classList.remove('report-open');
    opener?.focus();
  };

  const draw = () => {
    const s = store.getState().report;
    const set = (patch: Partial<typeof s>) => store.setReport(patch);
    const text = (label: string, value: string, key: 'title' | 'author', placeholder: string) => {
      const i = el('input', { attrs: { type: 'text', 'aria-label': label, placeholder } });
      i.value = value;
      i.addEventListener('change', () => set({ [key]: i.value }));
      return el('label', { class: 'field' }, [el('span', { text: label }), i]);
    };
    const notes = el('textarea', { attrs: { rows: '2', 'aria-label': 'Notes', placeholder: 'Optional notes' } });
    notes.value = s.notes;
    notes.addEventListener('change', () => set({ notes: notes.value }));
    const boxes = SECTION_IDS.map((id: SectionId) => {
      const c = el('input', { attrs: { type: 'checkbox' } });
      c.checked = s.sections[id];
      c.addEventListener('change', () => set({ sections: { ...s.sections, [id]: c.checked } }));
      return el('label', { class: 'check' }, [c, el('span', { text: id === 'header' ? 'Header and summary' : SECTION_TITLES[id] })]);
    });
    controls.replaceChildren(
      el('div', { class: 'report-bar' }, [
        el('h2', { text: 'Report' }),
        el('button', { class: 'btn primary', text: 'Print / save as PDF', on: { click: () => window.print() } }),
        el('button', { class: 'btn', text: 'Close report', on: { click: close } }),
      ]),
      el('p', { class: 'muted small', text: 'Choose the sections, then print. In the print dialog choose "Save as PDF" and A4. The report is built from the results shown in the app now; nothing is uploaded.' }),
      el('div', { class: 'field-row three' }, [text('Title', s.title, 'title', 'Optional title'), text('Author', s.author, 'author', 'Optional'), el('label', { class: 'field' }, [el('span', { text: 'Notes' }), notes])]),
      el('fieldset', { class: 'policy report-sections' }, [el('legend', { text: 'Sections' }), ...boxes]),
    );
    try {
      renderReport(paper, currentReport(store.getState()));
    } catch (e) {
      console.error(e);
      paper.replaceChildren(el('p', { class: 'export-msg', attrs: { role: 'alert' }, text: messageText(toUserMessage(e)) }));
    }
  };

  store.subscribe(() => {
    if (open) draw();
  });
  root.addEventListener('keydown', (e) => e.key === 'Escape' && close());

  return {
    async open(from: HTMLElement | null) {
      opener = from;
      open = true;
      await busy('Building the report', () => {
        document.body.classList.add('report-open');
        root.hidden = false;
        draw();
      });
      (controls.querySelector('button') as HTMLElement | null)?.focus();
    },
  };
}
