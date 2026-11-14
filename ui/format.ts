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
