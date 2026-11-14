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
