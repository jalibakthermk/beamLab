/**
 * Contour lines by marching squares, for display.
 *
 * Input is a row-major matrix z[iv][ih] on ascending axes h and v (any
 * spacing); null or non-finite values mean "no data". A cell is contoured
 * only if all four corners have data, so lines never enter or bridge empty
 * regions (they stop at the data edge). Crossing points are linearly
 * interpolated along cell edges; a value equal to the level counts as above.
 * Ambiguous (saddle) cells are resolved with the cell-centre average.
 * Segments are joined into polylines so dashed styles render continuously.
 */

export interface ContourLine {
  x: number[];
  y: number[];
  /** True if the line is a closed ring (first point repeated at the end). */
  closed: boolean;
}

type Matrix = ArrayLike<ArrayLike<number | null>>;

// Cell edges: 0 = bottom, 1 = right, 2 = top, 3 = left.
// Corner bits: a = bottom-left 1, b = bottom-right 2, c = top-right 4, d = top-left 8.
const CASES: Record<number, Array<[number, number]>> = {
  1: [[3, 0]],
  2: [[0, 1]],
  3: [[3, 1]],
  4: [[1, 2]],
  6: [[0, 2]],
  7: [[3, 2]],
  8: [[2, 3]],
  9: [[0, 2]],
  11: [[1, 2]],
  12: [[3, 1]],
  13: [[0, 1]],
  14: [[3, 0]],
};

export function contourLines(h: ArrayLike<number>, v: ArrayLike<number>, z: Matrix, level: number): ContourLine[] {
  const nH = h.length;
  const nV = v.length;
  if (nH < 2 || nV < 2 || !Number.isFinite(level)) return [];
  const hOff = nV * (nH - 1); // vertical-edge ids start here
  const val = (iv: number, ih: number): number => {
    const x = z[iv]![ih];
    return x === null || x === undefined || !Number.isFinite(x) ? NaN : x;
  };

  // Edge ids: horizontal edge (iv, ih)-(iv, ih+1) → iv*(nH-1)+ih; vertical (iv, ih)-(iv+1, ih) → hOff + iv*nH + ih
  const points = new Map<number, [number, number]>();
  const edgePoint = (id: number): [number, number] => {
    let p = points.get(id);
    if (p) return p;
    if (id < hOff) {
      const iv = Math.floor(id / (nH - 1));
      const ih = id - iv * (nH - 1);
      const z0 = val(iv, ih);
      const t = (level - z0) / (val(iv, ih + 1) - z0);
      p = [h[ih]! + t * (h[ih + 1]! - h[ih]!), v[iv]!];
    } else {
      const k = id - hOff;
      const iv = Math.floor(k / nH);
      const ih = k - iv * nH;
      const z0 = val(iv, ih);
      const t = (level - z0) / (val(iv + 1, ih) - z0);
      p = [h[ih]!, v[iv]! + t * (v[iv + 1]! - v[iv]!)];
    }
    points.set(id, p);
    return p;
  };

  const segA: number[] = [];
  const segB: number[] = [];
  for (let iv = 0; iv + 1 < nV; iv++) {
    for (let ih = 0; ih + 1 < nH; ih++) {
      const a = val(iv, ih);
      const b = val(iv, ih + 1);
      const c = val(iv + 1, ih + 1);
      const d = val(iv + 1, ih);
      if (Number.isNaN(a) || Number.isNaN(b) || Number.isNaN(c) || Number.isNaN(d)) continue;
      const code = (a >= level ? 1 : 0) | (b >= level ? 2 : 0) | (c >= level ? 4 : 0) | (d >= level ? 8 : 0);
      if (code === 0 || code === 15) continue;
      const edges = [iv * (nH - 1) + ih, hOff + iv * nH + ih + 1, (iv + 1) * (nH - 1) + ih, hOff + iv * nH + ih];
      let pairs = CASES[code];
      if (code === 5 || code === 10) {
        const centreAbove = (a + b + c + d) / 4 >= level;
        // Lines separate the below corners when the centre is above, and the above corners otherwise.
        const aboveAC = code === 5;
        pairs =
          centreAbove === aboveAC
            ? [[0, 1], [2, 3]] // around b and around d
            : [[3, 0], [1, 2]]; // around a and around c
      }
      for (const [e0, e1] of pairs!) {
        segA.push(edges[e0]!);
        segB.push(edges[e1]!);
      }
    }
  }

  // Join segments into polylines through shared edges (each edge touches at most two segments).
  const byEdge = new Map<number, number[]>();
  for (let s = 0; s < segA.length; s++) {
    for (const e of [segA[s]!, segB[s]!]) {
      const list = byEdge.get(e);
      if (list) list.push(s);
      else byEdge.set(e, [s]);
    }
  }
  const used = new Uint8Array(segA.length);
  const next = (edge: number): number | null => {
    for (const s of byEdge.get(edge) ?? []) {
      if (!used[s]) {
        used[s] = 1;
        return segA[s] === edge ? segB[s]! : segA[s]!;
      }
    }
    return null;
  };

  const lines: ContourLine[] = [];
  for (let s = 0; s < segA.length; s++) {
    if (used[s]) continue;
    used[s] = 1;
    const start = segA[s]!;
    const forward = [start, segB[s]!];
    let closed = false;
    for (let e = next(forward[1]!); e !== null; e = next(e)) {
      forward.push(e);
      if (e === start) {
        closed = true;
        break;
      }
    }
    let chain = forward;
    if (!closed) {
      const backward: number[] = [];
      for (let e = next(start); e !== null; e = next(e)) backward.push(e);
      chain = [...backward.reverse(), ...forward];
    }
    const pts = chain.map(edgePoint);
    lines.push({ x: pts.map((p) => p[0]), y: pts.map((p) => p[1]), closed });
  }
  return lines;
}

/** Concatenates polylines into one x/y pair separated by nulls (one plot trace per level). */
export function toLineXY(lines: ContourLine[]): { x: (number | null)[]; y: (number | null)[] } {
  const x: (number | null)[] = [];
  const y: (number | null)[] = [];
  lines.forEach((l, i) => {
    if (i > 0) {
      x.push(null);
      y.push(null);
    }
    x.push(...l.x);
    y.push(...l.y);
  });
  return { x, y };
}
