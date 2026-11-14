/**
 * Provenance of a dataset: which operation produced it, from which inputs,
 * with which parameters. Section 3.1 of FRAMEWORK.md.
 */
export interface Provenance {
  /** Operation name, e.g. 'import', 'add', 'subtract', 'scale', 'multiply', 'divide', 'clamp', 'window', 'resample'. */
  op: string;
  /** Ids of the input datasets (empty for a file import). */
  inputs: string[];
  /** Every parameter needed to reproduce the operation (operations also store inputNames). */
  params: Record<string, unknown>;
  /** ISO 8601 time the dataset was created. */
  timestamp: string;
  /**
   * Snapshot of each input's identity and provenance, so the full chain back to
   * the source files is available even after the inputs are removed.
   */
  parents?: ProvenanceParent[];
}

export interface ProvenanceParent {
  id: string;
  name: string;
  kind: string;
  provenance: Provenance | null;
}

export function makeProvenance(
  op: string,
  inputs: string[],
  params: Record<string, unknown>,
  timestamp: string = new Date().toISOString(),
): Provenance {
  return { op, inputs: [...inputs], params, timestamp };
}

const num = (x: unknown) => (typeof x === 'number' ? String(Number(x.toPrecision(6))) : String(x));

/** One readable sentence for a provenance step (ASCII only, so it can go into IES keyword lines). */
export function describeStep(p: Provenance | null): string {
  if (!p) return 'source data (no provenance recorded)';
  const q = p.params;
  const names = (q['inputNames'] as string[] | undefined) ?? p.inputs;
  const [a, b] = names;
  const grid = q['grid'] as { h: number; v: number } | undefined;
  const zero = q['zeroOutside'] as { a?: boolean; b?: boolean } | undefined;
  const binary =
    q['extent'] !== undefined
      ? `; extent ${q['extent']}; outside coverage: A ${zero?.a ? 'as zero' : 'NaN'}, B ${zero?.b ? 'as zero' : 'NaN'}; ` +
        (q['resampled'] ? `resampled onto a merged grid of ${grid?.h} x ${grid?.v}` : 'identical grids, node by node')
      : '';
  switch (p.op) {
    case 'import': {
      const conv = q['conversion'] as { from: string; targetStep: number } | null | undefined;
      let s = `import of ${q['format']} file, Type ${q['photometricType']}`;
      if (conv) s += ` converted to Type A at ${num(conv.targetStep)} deg steps`;
      if (q['symmetry']) s += `, symmetry expanded: ${q['symmetry']}`;
      if (q['flipH']) s += ', mirrored left/right (flipH)';
      if (q['tilt'] && q['tilt'] !== 'NONE') s += `, TILT=${q['tilt']} ignored`;
      return s;
    }
    case 'add': {
      const [wa, wb] = (q['weights'] as [number, number] | undefined) ?? [1, 1];
      return `add: ${num(wa)} x ${a} + ${num(wb)} x ${b}${binary}`;
    }
    case 'subtract':
      return `subtract: ${a} - ${b}${binary}`;
    case 'multiply':
      return `multiply: ${a} x ${b}${binary}`;
    case 'divide':
      return `divide: ${a} / ${b}, denominator floor ${num(q['floor'])} cd${q['floorIsDefault'] ? ' (default: 0.1% of the denominator peak)' : ''}${binary}`;
    case 'scale':
      return `scale: ${a} x ${num(q['k'])}`;
    case 'clamp':
      return `clamp negatives to zero (${q['clampedNodes']} nodes set to 0, on explicit request): ${a}`;
    case 'window': {
      const w = q['window'] as { hMin: number; hMax: number; vMin: number; vMax: number };
      return `window mask H ${num(w.hMin)}..${num(w.hMax)}, V ${num(w.vMin)}..${num(w.vMax)}${q['gridFrom'] ? ` on the grid of ${q['gridFrom']}` : ''}`;
    }
    case 'rotate': {
      const c = q['composedAngles'] as { yaw: number; pitch: number; roll: number } | undefined;
      let s = `rotate: yaw ${num(q['yaw'])}, pitch ${num(q['pitch'])}, roll ${num(q['roll'])} deg (roll, then pitch, then yaw); target grid ${q['target']}; interpolation ${q['interpolation']}`;
      if (q['composed'] && c) s += `; composed with the previous rotation: total yaw ${num(c.yaw)}, pitch ${num(c.pitch)}, roll ${num(c.roll)} deg, resampled once from ${q['resampledFrom']}`;
      return s;
    }
    case 'resample':
      return `resample of ${a ?? p.inputs[0]} (bilinear)`;
    default:
      return `${p.op}(${names.join(', ')})`;
  }
}

/**
 * The full chain back to the source files as readable text: one line per
 * step, children indented by two spaces and marked with "- ".
 */
export function provenanceChain(ds: { name: string; kind: string; provenance: Provenance | null }): string {
  const lines: string[] = [];
  const walk = (name: string, kind: string, p: Provenance | null, depth: number) => {
    const prefix = depth === 0 ? '' : `${'  '.repeat(depth)}- `;
    lines.push(`${prefix}${name} [${kind}] = ${describeStep(p)}${p && p.op !== 'import' ? ` (${p.timestamp})` : ''}`);
    for (const parent of p?.parents ?? []) walk(parent.name, parent.kind, parent.provenance, depth + 1);
  };
  walk(ds.name, ds.kind, ds.provenance, 0);
  return lines.join('\n');
}
