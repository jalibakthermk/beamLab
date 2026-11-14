/**
 * Busy indicator for calculations that take noticeable time (Phase 8).
 * Shows a status line, lets the browser paint it, then runs the work.
 */
let el: HTMLElement | null = null;
let depth = 0;

function indicator(): HTMLElement {
  if (!el) {
    el = document.createElement('div');
    el.className = 'busy';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.hidden = true;
    document.body.append(el);
  }
  return el;
}

// Let the browser paint the indicator. requestAnimationFrame does not run in a hidden tab, so a timer backs it up.
const nextPaint = () =>
  new Promise<void>((r) => {
    let done = false;
    const go = () => !done && ((done = true), setTimeout(r, 0));
    requestAnimationFrame(go);
    setTimeout(go, 50);
  });

/** Runs `work` with the indicator showing `label`. */
export async function busy<T>(label: string, work: () => T | Promise<T>): Promise<T> {
  const b = indicator();
  depth++;
  b.textContent = `⏳ ${label}…`;
  b.hidden = false;
  document.body.setAttribute('aria-busy', 'true');
  await nextPaint();
  try {
    return await work();
  } finally {
    depth--;
    if (depth === 0) {
      b.hidden = true;
      document.body.removeAttribute('aria-busy');
    }
  }
}
