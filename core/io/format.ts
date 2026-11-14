/** Number formatting shared by the exporters. */

/** Shortest decimal for an angle (round-trips exactly). */
export function formatAngle(a: number): string {
  return String(a === 0 ? 0 : a);
}

/** Value rounded to `precision` significant digits, never in exponent notation. */
export function formatValue(x: number, precision: number): string {
  const r = Number(x.toPrecision(precision));
  if (r === 0) return '0';
  const s = String(r);
  if (!s.includes('e')) return s;
  return r.toFixed(20).replace(/0+$/, '').replace(/\.$/, '');
}
