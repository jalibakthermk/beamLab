/**
 * Value-tracing diagnostic: follows (H, V) points from the raw file through
 * every parsing stage to sample(). Read-only; does not change any behaviour.
 * Run with: npm run diagnose -- <file.ies> <H,V> [<H,V> ...] [peak] [--flipH]
 */
import { parseIes, type IesStages } from '../core/io/ies';
import { sample, bracket } from '../core/geometry/interpolate';
import { anglesToVector, vectorToAngles, wrap360 } from '../core/geometry/coords';
import { summarize } from '../core/analysis/summary';
import type { PhotometricDataset } from '../core/model/dataset';

export interface Point {
  h: number;
  v: number;
  label?: string;
}

const EPS = 1e-9;
const f = (x: number, d = 6) => (Number.isFinite(x) ? Number(x.toPrecision(d)).toString() : 'NaN');
const deg = (x: number) => `${f(x, 8)}°`;

function steps(axis: number[]): string {
  const u = [...new Set(axis)].sort((a, b) => a - b);
  if (u.length < 2) return 'single angle';
  let min = Infinity;
  let max = -Infinity;
  for (let i = 1; i < u.length; i++) {
    const d = Number((u[i]! - u[i - 1]!).toFixed(9));
    min = Math.min(min, d);
    max = Math.max(max, d);
  }
  return min === max ? `${min}° (uniform)` : `${min}°–${max}° (non-uniform)`;
}

/** Maps a source-type angle to the angle actually written in the file, undoing symmetry expansion. */
function fileAngle(type: string, symmetry: string | null, h: number): number {
  if (!symmetry) return h;
  if (type !== 'C') return Math.abs(h); // lateral: H 0..90 mirrored
  const c = wrap360(h);
  if (symmetry.startsWith('rotational')) return 0;
  if (symmetry.startsWith('quadrant')) {
    const a = c > 180 ? 360 - c : c;
    return a > 90 ? 180 - a : a;
  }
  if (symmetry.includes('C0-C180')) return c > 180 ? 360 - c : c;
  if (symmetry.includes('C90-C270')) return c < 90 ? 180 - c : c > 270 ? 540 - c : c;
  return c;
}

interface Node {
  h: number;
  v: number;
  value: number;
}

function fourNodes(hAxis: number[], vAxis: number[], h: number, v: number, get: (ih: number, iv: number) => number): Node[] | string {
  const bh = bracket(hAxis, h);
  const bv = bracket(vAxis, v);
  if (!bh || !bv) return `outside the grid (H ${hAxis[0]}..${hAxis.at(-1)}, V ${vAxis[0]}..${vAxis.at(-1)})`;
  const out: Node[] = [];
  for (const iv of [bv.i0, bv.i1]) {
    for (const ih of [bh.i0, bh.i1]) {
      if (!out.some((n) => n.h === hAxis[ih] && n.v === vAxis[iv])) out.push({ h: hAxis[ih]!, v: vAxis[iv]!, value: get(ih, iv) });
    }
  }
  return out;
}

function nodeLines(nodes: Node[] | string, ref?: Node[] | string, factor?: number): string[] {
  if (typeof nodes === 'string') return [`      ${nodes}`];
  return nodes.map((n, i) => {
    let line = `      (${f(n.h, 8)}, ${f(n.v, 8)})  ${f(n.value, 9)}`;
    if (ref && typeof ref !== 'string' && ref[i]) {
      const r = ref[i]!.value;
      const ratio = n.value / r;
      line += `   ratio to raw ${f(ratio, 9)}`;
      if (factor !== undefined && Number.isFinite(ratio) && Math.abs(ratio - factor) > 1e-9 * Math.abs(factor)) line += '  <-- differs from applied factor';
    }
    return line;
  });
}

export function diagnose(text: string, name: string, points: Array<Point | 'peak'>, options: { flipH?: boolean } = {}): string {
  const flipH = options.flipH ?? false;
  const { dataset: ds, warnings, stages } = parseIes(text, { name, flipH });
  const raw: IesStages['raw'] = stages.raw;
  const src = stages.source;
  const conv = ds.provenance?.params['conversion'] as { targetStep: number } | null;
  const summary = summarize(ds);
  const out: string[] = [];

  out.push(`File: ${name}`);
  out.push(`  Format ${ds.meta.sourceFormat}, photometric type ${raw.type}`);
  out.push(`  Raw grid step: H ${steps(raw.hAngles)}, V ${steps(raw.vAngles)}  (${raw.hAngles.length} H × ${raw.vAngles.length} V in file)`);
  out.push(`  Raw H range ${Math.min(...raw.hAngles)}..${Math.max(...raw.hAngles)}, V range ${Math.min(...raw.vAngles)}..${Math.max(...raw.vAngles)}`);
  out.push(`  Symmetry expanded: ${src.symmetry ?? 'no'}`);
  out.push(`  Resampled to Type A: ${conv ? `yes, at ${conv.targetStep}° steps (bilinear)` : 'no (Type A grid used as is)'}`);
  out.push(`  flipH: ${flipH}`);
  out.push(
    `  Factors applied: candela multiplier ${raw.factors.multiplier} × ballast ${raw.factors.ballastFactor} × ballast-lamp/future-use ${raw.factors.ballastLampFactor} = ${raw.factors.total}`,
  );
  out.push(`  Canonical grid step: H ${steps(ds.grid.h)}, V ${steps(ds.grid.v)}`);
  out.push(`  Peak: ${f(summary.maxIntensity, 9)} cd at H ${summary.maxAt?.h}°, V ${summary.maxAt?.v}°`);
  out.push(`  Warnings: ${warnings.length ? warnings.map((w) => w.code).join(', ') : 'none'}`);

  const nV = raw.vAngles.length;
  const rawSortedH = [...new Set(raw.hAngles)].sort((a, b) => a - b);
  const rawSortedV = [...new Set(raw.vAngles)].sort((a, b) => a - b);
  const rawValue = (h: number, v: number) => raw.values[raw.hAngles.indexOf(h) * nV + raw.vAngles.indexOf(v)]!;

  for (const p0 of points) {
    const p: Point = p0 === 'peak' ? { h: summary.maxAt?.h ?? NaN, v: summary.maxAt?.v ?? NaN, label: 'peak' } : p0;
    out.push('');
    out.push(`Point H ${deg(p.h)}, V ${deg(p.v)}${p.label ? `  (${p.label})` : ''}  — viewer / canonical Type A coordinates`);

    // Canonical → source-type angles (undo flipH, then convert A → source type)
    const hUnflipped = flipH ? -p.h : p.h;
    const s = raw.type === 'A' ? { h: hUnflipped, v: p.v } : vectorToAngles(raw.type, anglesToVector('A', hUnflipped, p.v));
    const sh = raw.type === 'C' ? wrap360(s.h) : s.h;
    const fh = fileAngle(raw.type, src.symmetry, sh);
    out.push(
      `  Source (Type ${raw.type}) angles: ${raw.type === 'C' ? 'C' : 'H'} ${deg(sh)}, ${raw.type === 'C' ? 'γ' : 'V'} ${deg(s.v)}` +
        (fh !== sh ? `   → in the file as ${deg(fh)} (symmetry)` : '') +
        (flipH ? '   (flipH undone)' : ''),
    );
    const exact = raw.hAngles.some((a) => Math.abs(a - fh) < EPS) && raw.vAngles.some((a) => Math.abs(a - s.v) < EPS);
    out.push(`  Exact grid node in the source file: ${exact ? 'yes' : 'no'}`);

    const rawNodes = fourNodes(rawSortedH, rawSortedV, fh, s.v, (ih, iv) => rawValue(rawSortedH[ih]!, rawSortedV[iv]!));
    out.push('  1. Raw file values (as written, before scaling):');
    out.push(...nodeLines(rawNodes));

    const srcH = raw.type === 'C' && sh < EPS && src.h.at(-1) === 360 && src.h[0] !== 0 ? 360 : sh;
    const srcNodes = fourNodes(src.h, src.v, srcH, s.v, (ih, iv) => src.values[iv * src.h.length + ih]!);
    out.push(`  2. Parsed (scaled to absolute cd${src.symmetry ? ', symmetry expanded' : ''}; Type ${raw.type}):`);
    out.push(...nodeLines(srcNodes, src.symmetry ? undefined : rawNodes, raw.factors.total));
    if (src.symmetry) out.push('      (ratio to raw not shown: expanded nodes map to mirrored file nodes)');

    const canNodes = fourNodes(ds.grid.h, ds.grid.v, p.h, p.v, (ih, iv) => ds.values[iv * ds.grid.h.length + ih]!);
    out.push(`  3. Canonical dataset (Type A${conv ? ', resampled' : ''}${flipH ? ', flipped' : ''}):`);
    out.push(...nodeLines(canNodes, raw.type === 'A' && !flipH && !src.symmetry ? rawNodes : undefined, raw.factors.total));

    out.push(`  4. sample() at the point: ${f(sample(ds, p.h, p.v), 9)} cd`);
    if (raw.type !== 'A') {
      const direct = bilinearSource(src, srcH, s.v);
      out.push(`     (bilinear directly on the parsed Type ${raw.type} grid at the source angles: ${f(direct, 9)} cd)`);
    }
  }
  return out.join('\n');
}

function bilinearSource(src: IesStages['source'], h: number, v: number): number {
  const fake = {
    grid: { h: src.h, v: src.v },
    values: src.values,
    coverage: { hMin: src.h[0]!, hMax: src.h.at(-1)!, vMin: src.v[0]!, vMax: src.v.at(-1)! },
  } as unknown as PhotometricDataset;
  return sample(fake, h, v);
}
