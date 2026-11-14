const files = import.meta.glob<string>('./fixtures/*.ies', { query: '?raw', import: 'default', eager: true });

/** Raw text of a committed fixture in tests/fixtures/. */
export function fixture(name: string): string {
  const text = files[`./fixtures/${name}`];
  if (text === undefined) throw new Error(`fixture not found: ${name} (run npm run fixtures)`);
  return text;
}

export function fixtureNames(): string[] {
  return Object.keys(files).map((k) => k.replace('./fixtures/', ''));
}
