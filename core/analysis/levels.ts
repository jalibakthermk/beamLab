/** Contour levels and log-scale helpers for display. All values in cd. */

export type IntensityScale = 'linear' | 'log';

/** Smallest of 1, 2, 2.5, 5 × 10^k that is ≥ raw. */
export function niceStep(raw: number): number {
  const exp = Math.floor(Math.log10(raw));
  const base = 10 ** exp;
  for (const m of [1, 2, 2.5, 5, 10]) {
    const s = Number((m * base).toPrecision(12));
    if (s >= raw * (1 - 1e-12)) return s;
  }
  return 10 * base;
}

/**
 * Automatic contour levels.
 * linear: multiples of a nice step (about `count` levels) from step up to max; 0 is excluded.
 * log: 1-2-5 values per decade from `min` (default max/1000) up to max.
 */
export function autoLevels(max: number, scale: IntensityScale, options: { count?: number; min?: number } = {}): number[] {
  if (!(max > 0) || !Number.isFinite(max)) return [];
  if (scale === 'linear') {
    const step = niceStep(max / (options.count ?? 10));
    const out: number[] = [];
    for (let k = 1; k * step <= max * (1 + 1e-12); k++) out.push(Number((k * step).toPrecision(12)));
    return out;
  }
  const min = options.min !== undefined && options.min > 0 ? options.min : max / 1000;
  const out: number[] = [];
  for (let d = Math.floor(Math.log10(min)); d <= Math.floor(Math.log10(max)); d++) {
    for (const m of [1, 2, 5]) {
      const x = Number((m * 10 ** d).toPrecision(12));
      if (x >= min * (1 - 1e-12) && x <= max * (1 + 1e-12)) out.push(x);
    }
  }
  return out;
}

/** Parses a user-entered list of levels in cd (separated by spaces, commas or semicolons). */
export function parseLevels(text: string): { levels: number[]; invalid: string[] } {
  const invalid: string[] = [];
  const set = new Set<number>();
  for (const tok of text.split(/[\s,;]+/).filter((t) => t !== '')) {
    const x = Number(tok);
    if (Number.isFinite(x) && x > 0) set.add(x);
    else invalid.push(tok);
  }
  return { levels: [...set].sort((a, b) => a - b), invalid };
}

/**
 * Display floor for log scale: values ≤ 0 are shown at this value (display only).
 * One tenth of the smallest positive value, or 1e-3 cd if there is none.
 */
export function logFloor(values: ArrayLike<number>): number {
  let min = Infinity;
  for (let i = 0; i < values.length; i++) {
    const x = values[i]!;
    if (x > 0 && x < min) min = x;
  }
  return Number.isFinite(min) ? min / 10 : 1e-3;
}

/** Powers of ten within [min, max] (cd), for log colour-bar ticks. */
export function decadeTicks(min: number, max: number): number[] {
  const out: number[] = [];
  for (let d = Math.ceil(Math.log10(min) - 1e-12); d <= Math.floor(Math.log10(max) + 1e-12); d++) out.push(10 ** d);
  return out;
}

// ── Kind-aware display rules (Phase 3) ────────────────────────────────────

export type DisplayKind = 'intensity' | 'difference' | 'ratio' | 'mask';

export interface ValueRange {
  min: number;
  max: number;
  maxAbs: number;
  minPositive: number;
}

export function valueRange(values: ArrayLike<number>): ValueRange {
  let min = Infinity, max = -Infinity, minPositive = Infinity;
  for (let i = 0; i < values.length; i++) {
    const x = values[i]!;
    if (!Number.isFinite(x)) continue;
    if (x < min) min = x;
    if (x > max) max = x;
    if (x > 0 && x < minPositive) minPositive = x;
  }
  if (!Number.isFinite(min)) return { min: NaN, max: NaN, maxAbs: NaN, minPositive: NaN };
  return { min, max, maxAbs: Math.max(Math.abs(min), Math.abs(max)), minPositive: Number.isFinite(minPositive) ? minPositive : NaN };
}

/** Scale used to display a kind: difference and mask linear, ratio log, intensity as requested. */
export function displayScaleFor(kind: DisplayKind, requested: IntensityScale): IntensityScale {
  if (kind === 'ratio') return 'log';
  if (kind === 'difference' || kind === 'mask') return 'linear';
  return requested;
}

const RATIO_LEVELS = [0.1, 0.2, 0.5, 0.8, 0.9, 1, 1.1, 1.25, 2, 5, 10];

/** Automatic contour levels (data units) for each kind. */
export function levelsForKind(kind: DisplayKind, r: ValueRange, scale: IntensityScale): number[] {
  switch (kind) {
    case 'intensity':
      return autoLevels(r.max, scale);
    case 'difference': {
      if (!(r.maxAbs > 0)) return [0];
      const step = niceStep(r.maxAbs / 5);
      const out: number[] = [];
      for (let k = -Math.floor(r.maxAbs / step + 1e-9); k * step <= r.maxAbs * (1 + 1e-12); k++) {
        const x = Number((k * step).toPrecision(12));
        if (Math.abs(x) < r.maxAbs * (1 - 1e-12) || x === -r.maxAbs) out.push(x === 0 ? 0 : x);
      }
      return out;
    }
    case 'ratio':
      return RATIO_LEVELS.filter((x) => x >= r.minPositive * (1 - 1e-12) && x <= r.max * (1 + 1e-12));
    case 'mask':
      return [0.5];
  }
}

/** Colour range for a signed difference: symmetric about zero. */
export function divergingRange(r: ValueRange): { zmin: number; zmax: number } {
  const m = r.maxAbs > 0 ? r.maxAbs : 1;
  return { zmin: -m, zmax: m };
}

/** Colour range for a ratio in log10 units: symmetric about 1 (log 0), capped at ×100 either way. */
export function ratioLogRange(r: ValueRange): { zmin: number; zmax: number } {
  const hi = r.max > 0 ? Math.abs(Math.log10(r.max)) : 0;
  const lo = r.minPositive > 0 ? Math.abs(Math.log10(r.minPositive)) : 0;
  const m = Math.min(2, Math.max(hi, lo)) || 1;
  return { zmin: -m, zmax: m };
}
