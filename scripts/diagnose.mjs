// Usage: npm run diagnose -- <file.ies> <H,V> [<H,V> ...] [peak] [--flipH]
// Example: npm run diagnose -- local-data/lamp.ies 0,0 5,-0.8 peak
// Loads the real core/ code through Vite's module loader (no extra dependency).
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { createServer } from 'vite';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--') && /\.ies$/i.test(a));
if (!file) {
  console.error('Usage: npm run diagnose -- <file.ies> <H,V> [<H,V> ...] [peak] [--flipH]');
  process.exit(1);
}
const flipH = args.includes('--flipH');
const points = [];
for (const a of args) {
  if (a === file || a.startsWith('--')) continue;
  if (a === 'peak') {
    points.push('peak');
    continue;
  }
  const [h, v] = a.split(/[,;]/).map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(v)) {
    console.error(`Not a point: "${a}" (use H,V for example 5,-0.8)`);
    process.exit(1);
  }
  points.push({ h, v });
}

const buf = readFileSync(file);
let text;
try {
  text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
} catch {
  text = new TextDecoder('windows-1252').decode(buf);
}

const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
try {
  const { diagnose } = await server.ssrLoadModule('/scripts/diagnose.ts');
  console.log(diagnose(text, basename(file), points, { flipH }));
} finally {
  await server.close();
}
