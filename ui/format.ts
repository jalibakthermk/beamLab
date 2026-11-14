/** Display formatting only (no numeric logic). */

export function fmtCd(x: number): string {
  if (!Number.isFinite(x)) return '—';
  const a = Math.abs(x);
  if (a >= 100) return Math.round(x).toLocaleString('en-US');
  if (a >= 1) return x.toFixed(1);
  if (a === 0) return '0';
  return x.toPrecision(3);
}

export function fmtDeg(x: number, digits = 2): string {
  if (!Number.isFinite(x)) return '—';
  const s = x.toFixed(digits).replace(/\.?0+$/, '');
  return `${s === '-0' ? '0' : s}°`;
}

export function fmtStep(r: { min: number; max: number }): string {
  if (!Number.isFinite(r.min)) return '—';
  return r.min === r.max ? fmtDeg(r.min, 3) : `${fmtDeg(r.min, 3)}–${fmtDeg(r.max, 3)}`;
}

export function fmtLm(x: number): string {
  if (!Number.isFinite(x)) return '—';
  return x >= 100 ? `${Math.round(x).toLocaleString('en-US')} lm` : `${x.toPrecision(4)} lm`;
}

export function baseName(name: string): string {
  return name.replace(/\.[^.]+$/, '');
}

export type Kind = 'intensity' | 'difference' | 'ratio' | 'mask';

/** Unit shown after a value of this kind ('' for dimensionless). */
export function unitFor(kind: Kind): string {
  return kind === 'intensity' || kind === 'difference' ? 'cd' : '';
}

/** Value with its unit, e.g. "1,234 cd", "-56.2 cd", "1.234", "1 (inside)". */
export function fmtValue(kind: Kind, x: number): string {
  if (!Number.isFinite(x)) return 'no data';
  switch (kind) {
    case 'intensity':
      return `${fmtCd(x)} cd`;
    case 'difference':
      return `${x > 0 ? '+' : ''}${fmtCd(x)} cd`;
    case 'ratio':
      return x.toPrecision(4);
    case 'mask':
      return x >= 0.5 ? '1 (inside)' : '0 (outside)';
  }
}

export const KIND_LABEL: Record<Kind, string> = {
  intensity: 'intensity (cd)',
  difference: 'difference (signed cd)',
  ratio: 'ratio (no unit)',
  mask: 'mask (0 / 1)',
};
