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

  for (const name of FORBIDDEN_GLOBALS) {
    if (new RegExp(`(?<![\\w$.])${name}(?![\\w$])`).test(code)) {
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
  });
});
