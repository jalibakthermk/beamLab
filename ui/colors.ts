/** Viridis (perceptually uniform), as used by Plotly. Display only. */
const VIRIDIS: Array<[number, string]> = [
  [0, '#440154'], [0.0627, '#48186a'], [0.1255, '#472d7b'], [0.1882, '#424086'], [0.251, '#3b528b'],
  [0.3137, '#33638d'], [0.3765, '#2c728e'], [0.4392, '#26828e'], [0.502, '#21918c'], [0.5647, '#1fa088'],
  [0.6275, '#28ae80'], [0.6902, '#3fbc73'], [0.7529, '#5ec962'], [0.8157, '#84d44b'], [0.8784, '#addc30'],
  [0.9412, '#d8e219'], [1, '#fde725'],
];

const rgb = (hex: string): [number, number, number] => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
];

/** Colour at t in [0, 1]. */
export function viridis(t: number): string {
  const x = Math.min(1, Math.max(0, t));
  for (let i = 1; i < VIRIDIS.length; i++) {
    const [t1, c1] = VIRIDIS[i]!;
    if (x <= t1) {
      const [t0, c0] = VIRIDIS[i - 1]!;
      const f = (x - t0) / (t1 - t0);
      const a = rgb(c0);
      const b = rgb(c1);
      return `rgb(${a.map((v, k) => Math.round(v + f * (b[k]! - v))).join(',')})`;
    }
  }
  return VIRIDIS[VIRIDIS.length - 1]![1];
}

/** Viridis restricted to [0, end] as a Plotly colorscale (end < 1 avoids pale yellow lines on white). */
export function viridisScale(end: number, steps = 12): Array<[number, string]> {
  return Array.from({ length: steps + 1 }, (_, i) => [i / steps, viridis((i / steps) * end)] as [number, string]);
}

/** Diverging blue–white–red (ColorBrewer RdBu, reversed: negative blue, positive red). Display only. */
export const DIVERGING: Array<[number, string]> = [
  [0, '#053061'], [0.1, '#2166ac'], [0.2, '#4393c3'], [0.3, '#92c5de'], [0.4, '#d1e5f0'], [0.5, '#f7f7f7'],
  [0.6, '#fddbc7'], [0.7, '#f4a582'], [0.8, '#d6604d'], [0.9, '#b2182b'], [1, '#67001f'],
];
export const NEGATIVE_LINE = '#2166ac';
export const POSITIVE_LINE = '#b2182b';

/** Two-tone scale for masks: 0 grey, 1 accent. */
export function maskScale(accent: string): Array<[number, string]> {
  return [[0, '#bdbdb8'], [0.4999, '#bdbdb8'], [0.5, accent], [1, accent]];
}
