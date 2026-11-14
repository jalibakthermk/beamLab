// Regenerates tests/fixtures/*.ies from tests/fixtures/generate.ts.
// Node runs the .ts file directly (type stripping). Usage: npm run fixtures
import { readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { buildFixtures } from '../tests/fixtures/generate.ts';

const dir = new URL('../tests/fixtures/', import.meta.url);
for (const name of readdirSync(dir)) if (name.endsWith('.ies')) unlinkSync(new URL(name, dir));
const fixtures = buildFixtures();
for (const [name, text] of Object.entries(fixtures)) writeFileSync(new URL(name, dir), text);
console.log(`wrote ${Object.keys(fixtures).length} fixtures to tests/fixtures/`);
