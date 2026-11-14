import { describe, expect, it } from 'vitest';
import { buildFixtures } from './fixtures/generate';
import { fixture, fixtureNames } from './load-fixture';

describe('committed fixtures', () => {
  const generated = buildFixtures();

  it('are exactly what the generator produces (run npm run fixtures after changing it)', () => {
    expect(fixtureNames().sort()).toEqual(Object.keys(generated).sort());
    for (const [name, text] of Object.entries(generated)) expect(fixture(name), name).toBe(text);
  });
});
