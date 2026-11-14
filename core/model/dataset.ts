import type { Provenance } from './provenance';

/**
 * Canonical in-memory model (FRAMEWORK.md section 3.1).
 *
 * Convention: Type A, H-V, polar axis vertical. H positive to the right,
 * V positive up, as seen from the lamp looking forward. Direction vector:
 *   x(forward) = cos V · cos H,  y(right) = cos V · sin H,  z(up) = sin V.
 * Angles in degrees, both axes strictly ascending.
 * `values` is row-major [v][h]: index = iv * h.length + ih.
 * For kind 'intensity', values are absolute candela (all file factors applied).
 * Points outside coverage are NaN, never silently zero.
 */

/**
 * intensity: absolute cd (exportable as IES). difference: signed cd (A − B).
 * ratio: dimensionless (A / B). mask: 0 or 1 (multiplier for windowing).
 */
export type DatasetKind = 'intensity' | 'difference' | 'ratio' | 'mask';
export type PhotometricType = 'A' | 'B' | 'C';
export type SourceFormat =
  | 'LM-63-1986'
  | 'LM-63-1991'
  | 'LM-63-1995'
  | 'LM-63-2002'
  | 'LM-63-2019'
  | 'derived'
  | 'synthetic';

export interface Grid {
  /** Horizontal angles in degrees, strictly ascending, within [-180, 180]. */
  h: number[];
  /** Vertical angles in degrees, strictly ascending, within [-90, 90]. */
  v: number[];
}

/** Bounding box where data is real (not padded). NaN may still occur inside it for converted files. */
export interface Coverage {
  hMin: number;
  hMax: number;
  vMin: number;
  vMax: number;
}

export interface Keyword {
  /** Upper-case keyword without brackets, e.g. 'TEST'. 'LABEL' for free-text lines (LM-63-1986). */
  key: string;
  /** Value; [MORE] continuation lines are joined with '\n'. */
  value: string;
}

export interface Dimensions {
  width: number;
  length: number;
  height: number;
  units: 'feet' | 'meters' | 'unknown';
}

export interface DatasetMeta {
  keywords: Keyword[];
  /** Total rated lamp lumens (lamps × lumens per lamp); null for absolute photometry (-1 in file). */
  lumens: number | null;
  /** Candela multiplier from the file (already applied to values). */
  multiplier: number;
  /** Ballast factor from the file (already applied to values). */
  ballastFactor: number;
  /** Ballast-lamp photometric factor / "future use" field (already applied to values). */
  ballastLampFactor: number;
  /** Input watts from the file. */
  watts: number;
  dimensions: Dimensions | null;
  /** Photometric type of the source file before conversion to Type A. */
  sourceType: PhotometricType;
  sourceFormat: SourceFormat;
}

export interface PhotometricDataset {
  id: string;
  name: string;
  /** Only 'intensity' may be exported as IES. */
  kind: DatasetKind;
  grid: Grid;
  values: Float64Array;
  coverage: Coverage;
  meta: DatasetMeta;
  provenance: Provenance | null;
}

export class DatasetError extends Error {
  override name = 'DatasetError';
}

export function valueIndex(grid: Grid, iv: number, ih: number): number {
  return iv * grid.h.length + ih;
}

export function gridBounds(grid: Grid): Coverage {
  return {
    hMin: grid.h[0]!,
    hMax: grid.h[grid.h.length - 1]!,
    vMin: grid.v[0]!,
    vMax: grid.v[grid.v.length - 1]!,
  };
}

function checkAxis(name: string, axis: number[], limit: number): void {
  if (axis.length === 0) throw new DatasetError(`${name} axis is empty`);
  for (let i = 0; i < axis.length; i++) {
    const a = axis[i]!;
    if (!Number.isFinite(a)) throw new DatasetError(`${name} axis has a non-finite angle at index ${i}`);
    if (a < -limit || a > limit) throw new DatasetError(`${name} angle ${a} is outside [-${limit}, ${limit}]`);
    if (i > 0 && a <= axis[i - 1]!) throw new DatasetError(`${name} axis is not strictly ascending at index ${i}`);
  }
}

export type DatasetInit = Omit<PhotometricDataset, 'coverage'> & { coverage?: Coverage };

/** Validates the grid and value count and returns a dataset. Throws DatasetError on invalid input. */
export function createDataset(init: DatasetInit): PhotometricDataset {
  checkAxis('H', init.grid.h, 180);
  checkAxis('V', init.grid.v, 90);
  const expected = init.grid.h.length * init.grid.v.length;
  if (init.values.length !== expected) {
    throw new DatasetError(`values has ${init.values.length} entries, grid needs ${expected}`);
  }
  return { ...init, coverage: init.coverage ?? gridBounds(init.grid) };
}
