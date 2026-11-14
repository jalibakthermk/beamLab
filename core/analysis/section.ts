import type { PhotometricDataset } from '../model/dataset';
import { sample } from '../geometry/interpolate';

/** Intensity along one axis at a fixed angle on the other axis, from full-resolution data. */
export interface Section {
  /** 'H': values vs H at fixed V. 'V': values vs V at fixed H. */
  axis: 'H' | 'V';
  /** The fixed angle on the other axis (degrees). */
  at: number;
  /** Grid angles along the section axis (degrees). */
  angles: number[];
  /** Bilinear samples; NaN where there is no data. */
  values: number[];
}

/** Intensity vs H at fixed V, at every grid H. */
export function hSection(dataset: PhotometricDataset, v: number): Section {
  const angles = [...dataset.grid.h];
  return { axis: 'H', at: v, angles, values: angles.map((h) => sample(dataset, h, v)) };
}

/** Intensity vs V at fixed H, at every grid V. */
export function vSection(dataset: PhotometricDataset, h: number): Section {
  const angles = [...dataset.grid.v];
  return { axis: 'V', at: h, angles, values: angles.map((v) => sample(dataset, h, v)) };
}
