import { describe, expect, it } from 'vitest';

/**
 * core/ must stay a pure library: no imports from ui/ and no DOM globals.
 * (tsconfig.core.json also type-checks core/ without the DOM lib.)
 */

const coreSources = import.meta.glob<string>('../core/**/*.{ts,js,mts}', {
  query: '?raw',
  import: 'default',
  eager: true,
});

const FORBIDDEN_GLOBALS = ['document', 'window'];

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Removes the contents of string literals (keeps the quotes), so words inside strings are not flagged. */
function stripStrings(src: string): string {
  return src.replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g, (m) => m[0]! + m[0]!);
}

export function findViolations(src: string): string[] {
  const code = stripComments(src);
  const problems: string[] = [];

  const specifiers = [
    ...code.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g),
    ...code.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g),
    ...code.matchAll(/\bimport\s*['"]([^'"]+)['"]/g),
    ...code.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g),
  ].map((m) => m[1] ?? '');
  for (const spec of specifiers) {
    if (/(^|\/)ui(\/|$)/.test(spec)) problems.push(`imports from ui/: "${spec}"`);
  }

  const noStrings = stripStrings(code);
  for (const name of FORBIDDEN_GLOBALS) {
    // An identifier use, not a property access (x.window), an object key ({ window: 1 }) or text in a string
    if (new RegExp(`(?<![\\w$.])${name}(?![\\w$])(?!\\s*:(?!:))`).test(noStrings)) {
      problems.push(`references ${name}`);
    }
  }
  return problems;
}

describe('core/ purity', () => {
  it('finds core source files to check', () => {
    expect(Object.keys(coreSources).length).toBeGreaterThan(0);
  });

  it.each(Object.entries(coreSources))('%s has no ui/ imports or DOM globals', (_file, src) => {
    expect(findViolations(src)).toEqual([]);
  });

  it('detector catches violations (self-test)', () => {
    expect(findViolations(`import { x } from '../../ui/panel';`)).toHaveLength(1);
    expect(findViolations(`const el = document.body;`)).toHaveLength(1);
    expect(findViolations(`window.alert('x');`)).toHaveLength(1);
    expect(findViolations(`// document is fine in a comment\nconst docs = 1;`)).toEqual([]);
    expect(findViolations(`const op = 'window'; const p = { window: 1 }; const t = "document";`)).toEqual([]);
    expect(findViolations(`const w = window;`)).toHaveLength(1);
    expect(findViolations(`if (typeof document !== 'undefined') {}`)).toHaveLength(1);
  });
});
