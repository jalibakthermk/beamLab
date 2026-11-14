import type { PhotometricType } from '../model/dataset';

/**
 * Photometric coordinate systems as unit direction vectors.
 *
 * Vehicle frame: [x, y, z] = [forward, right, up]. forward × right = up, so
 * the frame is right-handed.
 *
 * All angles are in degrees.
 *
 * ── Type A (fixed by FRAMEWORK.md 3.1; not an assumption) ──────────────────
 *   Polar axis vertical. H rotates about the vertical axis (positive right),
 *   V is the elevation above the horizontal plane (positive up):
 *     d = cos V · cos H · F + cos V · sin H · R + sin V · U
 *   Inverse: V = asin(d·U), H = atan2(d·R, d·F).
 *
 * ── Type B (derived from LM-63; vehicle mapping is an ASSUMPTION) ─────────
 *   LM-63: "the polar axis of the luminaire coincides with the minor axis
 *   (width), and the 0–180 photometric plane coincides with the vertical axis".
 *   So the polar axis is horizontal and lateral (L). The photometric planes all
 *   contain L; a plane is identified by its tilt V about L (V = 0 is the plane
 *   containing F, V = +90 the plane containing U). Within a plane, H is the
 *   angle from the plane's zero line (the line perpendicular to L) toward L.
 *   A point is reached by first tilting by V about L, then turning by H toward L:
 *     d = cos H · (cos V · F + sin V · U) + sin H · L
 *   Inverse: H = asin(d·L), V = atan2(d·U, d·F).
 *   H = ±90 are the poles (V undefined there). Lateral symmetry is H → -H,
 *   which is why LM-63 allows H = 0..90 for laterally symmetric files.
 *
 * ── Type C (derived from LM-63; vehicle mapping is an ASSUMPTION) ─────────
 *   LM-63: "the polar axis coincides with the vertical axis of the luminaire".
 *   Vertical angle γ is measured from nadir N (γ = 0 down, 90 horizontal,
 *   180 up). Horizontal angle C identifies the half-plane containing the polar
 *   axis, measured from the 0° plane P0 toward the 90° plane P90:
 *     d = sin γ · (cos C · P0 + sin C · P90) + cos γ · N
 *   Inverse: γ = acos(d·N), C = atan2(d·P90, d·P0) mapped to [0, 360).
 *   γ = 0 and 180 are the poles (C undefined there).
 *
 * The vectors F/L/U and P0/P90/N for Types B and C are not defined relative
 * to a vehicle by LM-63. They are collected in AXIS_ASSUMPTIONS below, and the
 * parser warns whenever a Type B or C file is loaded.
 */

export type Vec3 = readonly [number, number, number];

export const FORWARD: Vec3 = [1, 0, 0];
export const RIGHT: Vec3 = [0, 1, 0];
export const LEFT: Vec3 = [0, -1, 0];
export const UP: Vec3 = [0, 0, 1];
export const DOWN: Vec3 = [0, 0, -1];

export interface AxisAssumptions {
  B: {
    /** Direction of H = 0, V = 0. */
    zero: Vec3;
    /** Polar axis: direction of H = +90. */
    hPositive: Vec3;
    /** Direction of H = 0, V = +90. */
    vPositive: Vec3;
  };
  C: {
    /** Direction of γ = 0. */
    nadir: Vec3;
    /** Direction of C = 0, γ = 90. */
    plane0: Vec3;
    /** Direction of C = 90, γ = 90. */
    plane90: Vec3;
  };
}

/**
 * The single place where Type B and Type C axes are mapped onto vehicle axes.
 *
 * Type B: lamp faces forward, polar axis is the vehicle's lateral axis,
 *   H positive to the RIGHT and V positive UP (same signs as Type A).
 * Type C: polar axis vertical, γ = 0 at nadir (DOWN), C = 0 points FORWARD,
 *   C increases counter-clockwise when viewed from above, so C = 90 is LEFT.
 */
export const AXIS_ASSUMPTIONS: AxisAssumptions = Object.freeze({
  B: Object.freeze({ zero: FORWARD, hPositive: RIGHT, vPositive: UP }),
  C: Object.freeze({ nadir: DOWN, plane0: FORWARD, plane90: LEFT }),
});

export interface Angles {
  /** Type A/B: H. Type C: C-plane angle. Degrees. */
  h: number;
  /** Type A/B: V. Type C: γ from nadir. Degrees. */
  v: number;
}

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const clamp1 = (x: number): number => (x > 1 ? 1 : x < -1 ? -1 : x);

function combine(a: number, u: Vec3, b: number, w: Vec3, c: number, z: Vec3): Vec3 {
  return [a * u[0] + b * w[0] + c * z[0], a * u[1] + b * w[1] + c * z[1], a * u[2] + b * w[2] + c * z[2]];
}

/** Maps any angle to [0, 360), with no negative zero. */
export function wrap360(deg: number): number {
  let c = deg % 360;
  if (c < 0) c += 360;
  if (c >= 360) c -= 360;
  return c === 0 ? 0 : c;
}

export function anglesToVector(
  type: PhotometricType,
  h: number,
  v: number,
  axes: AxisAssumptions = AXIS_ASSUMPTIONS,
): Vec3 {
  const ch = Math.cos(h * D2R);
  const sh = Math.sin(h * D2R);
  const cv = Math.cos(v * D2R);
  const sv = Math.sin(v * D2R);
  switch (type) {
    case 'A':
      return [cv * ch, cv * sh, sv];
    case 'B': {
      const { zero, hPositive, vPositive } = axes.B;
      return combine(ch * cv, zero, sh, hPositive, ch * sv, vPositive);
    }
    case 'C': {
      // here h = C, v = γ
      const { nadir, plane0, plane90 } = axes.C;
      return combine(sv * ch, plane0, sv * sh, plane90, cv, nadir);
    }
  }
}

export function vectorToAngles(
  type: PhotometricType,
  vec: Vec3,
  axes: AxisAssumptions = AXIS_ASSUMPTIONS,
): Angles {
  const len = Math.hypot(vec[0], vec[1], vec[2]);
  const d: Vec3 = [vec[0] / len, vec[1] / len, vec[2] / len];
  switch (type) {
    case 'A': {
      const v = Math.asin(clamp1(d[2])) * R2D;
      const h = Math.atan2(d[1], d[0]) * R2D;
      return { h: h === 0 ? 0 : h, v: v === 0 ? 0 : v };
    }
    case 'B': {
      const { zero, hPositive, vPositive } = axes.B;
      const h = Math.asin(clamp1(dot(d, hPositive))) * R2D;
      const v = Math.atan2(dot(d, vPositive), dot(d, zero)) * R2D;
      return { h: h === 0 ? 0 : h, v: v === 0 ? 0 : v };
    }
    case 'C': {
      const { nadir, plane0, plane90 } = axes.C;
      const g = Math.acos(clamp1(dot(d, nadir))) * R2D;
      const c = wrap360(Math.atan2(dot(d, plane90), dot(d, plane0)) * R2D);
      return { h: c, v: g };
    }
  }
}
