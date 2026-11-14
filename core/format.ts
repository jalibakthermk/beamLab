/**
 * Number formatting for display and the report, in one place (Phase 8).
 * Display only: never used to round values that are computed with.
 * Missing or non-finite values show as "—".
 */

const DASH = '—';
const ok = (x: number | null | undefined): x is number => typeof x === 'number' && Number.isFinite(x);
const noNegZero = (s: string) => (/^-0(\.0*)?$/.test(s) ? s.slice(1) : s);

/** x to `sig` significant figures, never in exponent notation. */
export function fmtSig(x: number | null | undefined, sig = 4): string {
  if (!ok(x)) return DASH;
  if (x === 0) return '0';
  const r = Number(x.toPrecision(sig));
  const s = Math.abs(r) >= 1e-6 ? String(r) : r.toFixed(20).replace(/0+$/, '');
  return noNegZero(s.includes('e') ? r.toFixed(Math.max(0, sig - 1 - Math.floor(Math.log10(Math.abs(r))))) : s);
}

/** Intensity: whole cd with thousands separators from 100 cd, one decimal from 1 cd, else 3 significant figures. */
export function fmtCd(x: number | null | undefined): string {
  if (!ok(x)) return DASH;
  const a = Math.abs(x);
  if (a >= 100) return Math.round(x).toLocaleString('en-US');
  if (a >= 1) return noNegZero(x.toFixed(1));
  if (a === 0) return '0';
  return fmtSig(x, 3);
}

/** Illuminance: whole lx from 100, one decimal from 10, two from 1, else 3 significant figures. */
export function fmtLx(x: number | null | undefined): string {
  if (!ok(x)) return DASH;
  const a = Math.abs(x);
  if (a >= 100) return Math.round(x).toLocaleString('en-US');
  if (a >= 10) return noNegZero(x.toFixed(1));
  if (a >= 1) return noNegZero(x.toFixed(2));
  if (a === 0) return '0';
  return fmtSig(x, 3);
}

/** Angle with up to `digits` decimals, trailing zeros removed, with the degree sign. */
export function fmtDeg(x: number | null | undefined, digits = 2): string {
  if (!ok(x)) return DASH;
  const s = x.toFixed(digits).replace(/\.?0+$/, '');
  return `${s === '-0' ? '0' : s}°`;
}

/** Angle with exactly `digits` decimals (for aims and corrections), with the degree sign. */
export function fmtDegFixed(x: number | null | undefined, digits = 3): string {
  return ok(x) ? `${noNegZero(x.toFixed(digits))}°` : DASH;
}

/** Percentage with `digits` decimals; `signed` adds + to positive values. */
export function fmtPct(x: number | null | undefined, digits = 1, signed = false): string {
  if (!ok(x)) return DASH;
  const s = noNegZero(x.toFixed(digits));
  return `${signed && x > 0 ? '+' : ''}${s}%`;
}

/** Length in metres with `digits` decimals; `unit` appends " m". */
export function fmtM(x: number | null | undefined, digits = 2, unit = false): string {
  if (!ok(x)) return DASH;
  return `${noNegZero(x.toFixed(digits))}${unit ? ' m' : ''}`;
}

/** Luminous flux in lm. */
export function fmtLm(x: number | null | undefined): string {
  if (!ok(x)) return DASH;
  return x >= 100 ? `${Math.round(x).toLocaleString('en-US')} lm` : `${fmtSig(x, 4)} lm`;
}

/** Dimensionless number (ratio, gradient) to `sig` significant figures. */
export const fmtNumber = fmtSig;

export interface StepRange {
  min: number;
  max: number;
}
export function fmtStep(r: StepRange): string {
  if (!ok(r.min)) return DASH;
  return r.min === r.max ? fmtDeg(r.min, 3) : `${fmtDeg(r.min, 3)}–${fmtDeg(r.max, 3)}`;
}

export type Kind = 'intensity' | 'difference' | 'ratio' | 'mask';

/** Unit shown after a value of this kind ('' for dimensionless). */
export function unitFor(kind: Kind): string {
  return kind === 'intensity' || kind === 'difference' ? 'cd' : '';
}

/** Value with its unit, e.g. "1,234 cd", "+56.2 cd", "1.234", "1 (inside)". */
export function fmtValue(kind: Kind, x: number): string {
  if (!Number.isFinite(x)) return 'no data';
  switch (kind) {
    case 'intensity':
      return `${fmtCd(x)} cd`;
    case 'difference':
      return `${x > 0 ? '+' : ''}${fmtCd(x)} cd`;
    case 'ratio':
      return fmtSig(x, 4);
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

/** Status as text with an icon, so it never depends on colour alone. */
export function fmtStatus(s: 'pass' | 'fail' | 'not-evaluated' | 'incomplete'): string {
  return s === 'pass' ? '✓ pass' : s === 'fail' ? '✗ fail' : s === 'incomplete' ? '◐ incomplete' : '– not evaluated';
}
