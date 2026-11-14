import { describe, expect, it } from 'vitest';
import {
  anglesFromMatrix,
  applyMatrix,
  multiplyMatrices,
  pitchFromPercent,
  planRotation,
  rotate,
  rotationMatrix,
} from '../core/geometry/rotate';
import { anglesToVector, vectorToAngles } from '../core/geometry/coords';
import { sample } from '../core/geometry/interpolate';
import { flux } from '../core/geometry/flux';
import { summarize } from '../core/analysis/summary';
import { parseIes } from '../core/io/ies';
import { scale } from '../core/ops/arithmetic';
import { provenanceChain } from '../core/model/provenance';
import { GAUSS, sameBeam, dirTypeA } from './fixtures/generate';
import { fixture } from './load-fixture';

const R = Math.PI / 180;
const turn = (h: number, v: number, aim: { yaw?: number; pitch?: number; roll?: number }) =>
  vectorToAngles('A', applyMatrix(rotationMatrix({ yaw: 0, pitch: 0, roll: 0, ...aim }), anglesToVector('A', h, v)));

const gauss = parseIes(fixture('gaussian-spot-typeA.ies'), { name: 'gauss.ies' }).dataset;
const asym = parseIes(fixture('asymmetric-typeA.ies'), { name: 'asym.ies' }).dataset;
const smooth = parseIes(fixture('same-beam-typeA.ies'), { name: 'smooth.ies' }).dataset;

describe('sign conventions on direction vectors (x forward, y right, z up)', () => {
  it('positive yaw moves the beam right (+H), by exactly the yaw angle', () => {
    const a = turn(10, -3, { yaw: 4 });
    expect(a.h).toBeCloseTo(14, 12);
    expect(a.v).toBeCloseTo(-3, 12);
  });

  it('a point on the H = 0 line pitched by p moves to V + p exactly', () => {
    for (const [v, p] of [[0, 2], [-5, 1.5], [12, -7]] as const) {
      const a = turn(0, v, { pitch: p });
      expect(a.h).toBeCloseTo(0, 12);
      expect(a.v).toBeCloseTo(v + p, 12);
    }
  });

  it('the direction H = 90, V = 0 (the pitch axis) is unchanged by pitch', () => {
    const a = turn(90, 0, { pitch: 25 });
    expect(a.h).toBeCloseTo(90, 12);
    expect(a.v).toBeCloseTo(0, 12);
  });

  it('pitch is not a V shift away from H = 0 (why aim must be a true rotation)', () => {
    const a = turn(30, 0, { pitch: 5 });
    expect(Math.abs(a.v - 5)).toBeGreaterThan(0.6); // a V shift would give exactly 5
  });

  it('roll 90 maps (H = h, V = 0) onto the H = 0 line at V = −h: clockwise seen from the lamp, right goes down', () => {
    for (const h of [10, 25, -15]) {
      const a = turn(h, 0, { roll: 90 });
      expect(a.h).toBeCloseTo(0, 10);
      expect(a.v).toBeCloseTo(-h, 10);
    }
  });

  it('order is roll, then pitch, then yaw: R = Yaw · Pitch · Roll', () => {
    const aim = { yaw: 7, pitch: -3, roll: 12 };
    const step = multiplyMatrices(
      rotationMatrix({ yaw: 7, pitch: 0, roll: 0 }),
      multiplyMatrices(rotationMatrix({ yaw: 0, pitch: -3, roll: 0 }), rotationMatrix({ yaw: 0, pitch: 0, roll: 12 })),
    );
    rotationMatrix(aim).forEach((x, i) => expect(x).toBeCloseTo(step[i]!, 14));
  });

  it('anglesFromMatrix recovers yaw, pitch and roll', () => {
    const aim = { yaw: -23.5, pitch: 11.25, roll: 37 };
    const back = anglesFromMatrix(rotationMatrix(aim));
    expect(back.yaw).toBeCloseTo(aim.yaw, 10);
    expect(back.pitch).toBeCloseTo(aim.pitch, 10);
    expect(back.roll).toBeCloseTo(aim.roll, 10);
  });

  it('pitch from inclination in percent: atan(p / 100), 1% = 0.573°', () => {
    expect(pitchFromPercent(1)).toBeCloseTo(0.5729387, 6);
    expect(pitchFromPercent(-2.5)).toBeCloseTo(-Math.atan(0.025) / R, 12);
  });
});

describe('rotating datasets', () => {
  it('pure yaw is an exact H shift: no resampling, values unchanged', () => {
    const { dataset: r, report } = rotate(gauss, { yaw: 5, pitch: 0, roll: 0 });
    expect(r.grid.h).toEqual(gauss.grid.h.map((h) => Number((h + 5).toFixed(9))));
    expect(r.grid.v).toEqual(gauss.grid.v);
    expect(Array.from(r.values)).toEqual(Array.from(gauss.values));
    expect(report.fastPath).toBe(true);
    expect(report.outsideFraction).toBe(0);
    expect(r.provenance?.params['interpolation']).toMatch(/none/);
  });

  it('on the dataset, the H = 0 column pitched by one grid step lands exactly one row up', () => {
    const { dataset: r } = rotate(gauss, { yaw: 0, pitch: 0.5, roll: 0 });
    for (const v of [-10, -3, 0, 5]) expect(sample(r, 0, v + 0.5)).toBeCloseTo(sample(gauss, 0, v), 9);
  });

  it('Gaussian peak lands at the hand-computed position after yaw 3, pitch 2', () => {
    // Hand computation: peak direction d = (cos V cos H, cos V sin H, sin V) at H 10, V -3;
    // pitch 2: x' = cos2·x − sin2·z, z' = sin2·x + cos2·z; then yaw 3 adds 3° to H.
    const [x, y, z] = [Math.cos(-3 * R) * Math.cos(10 * R), Math.cos(-3 * R) * Math.sin(10 * R), Math.sin(-3 * R)];
    const xp = Math.cos(2 * R) * x - Math.sin(2 * R) * z;
    const zp = Math.sin(2 * R) * x + Math.cos(2 * R) * z;
    const expected = { h: Math.atan2(y, xp) / R + 3, v: Math.asin(zp) / R };
    expect(expected.h).toBeCloseTo(12.988, 2);
    expect(expected.v).toBeCloseTo(-1.030, 2);
    const { dataset: r, report } = rotate(gauss, { yaw: 3, pitch: 2, roll: 0 });
    const s = summarize(r);
    expect(Math.abs(s.maxAt!.h - expected.h)).toBeLessThanOrEqual(0.25); // within half a grid step (0.5°)
    expect(Math.abs(s.maxAt!.v - expected.v)).toBeLessThanOrEqual(0.25);
    expect(report.peakAfter.h).toBe(s.maxAt!.h);
    expect(report.peakBefore).toEqual({ value: GAUSS.peak, h: GAUSS.h0, v: GAUSS.v0 });
  });

  it('asymmetric fixture: yaw +, pitch + and roll + move the hot spot (H 20, V 5) right, up and clockwise', () => {
    const peak = (aim: { yaw: number; pitch: number; roll: number }) => summarize(rotate(asym, aim).dataset).maxAt!;
    expect(peak({ yaw: 6, pitch: 0, roll: 0 }).h).toBeGreaterThan(24);
    expect(peak({ yaw: -6, pitch: 0, roll: 0 }).h).toBeLessThan(16);
    expect(peak({ yaw: 0, pitch: 4, roll: 0 }).v).toBeGreaterThan(7);
    expect(peak({ yaw: 0, pitch: -4, roll: 0 }).v).toBeLessThan(3);
    // Clockwise seen from the lamp: a spot right of centre and slightly up moves down
    expect(peak({ yaw: 0, pitch: 0, roll: 10 }).v).toBeLessThan(3);
    expect(peak({ yaw: 0, pitch: 0, roll: -10 }).v).toBeGreaterThan(7);
  });

  it('nodes whose source direction is outside coverage are NaN, and the report counts them', () => {
    const { dataset: r, report } = rotate(gauss, { yaw: 0, pitch: 5, roll: 0 });
    expect(sample(r, 0, -14.5)).toBeNaN(); // came from V -19.5, below the source's -15
    expect(report.outsideFraction).toBeGreaterThan(0.15);
    expect(report.outsideFraction).toBeLessThan(0.25);
  });

  it('extended target grid contains the rotated coverage; same grid is the default', () => {
    const same = rotate(gauss, { yaw: 0, pitch: 5, roll: 0 });
    const ext = rotate(gauss, { yaw: 0, pitch: 5, roll: 0 }, { target: 'extended' });
    expect(same.dataset.grid).toEqual(gauss.grid);
    expect(ext.dataset.grid.v.at(-1)).toBeGreaterThanOrEqual(14.9);
    expect(ext.dataset.grid.v[0]).toBe(-15);
    expect(ext.report.fluxAfter).toBeGreaterThan(same.report.fluxAfter);
    expect(ext.dataset.provenance?.params['target']).toBe('extended');
  });

  it('keeps the kind, and records angles, order, target grid and interpolation in provenance', () => {
    const d = scale(gauss, 2);
    const { dataset: r } = rotate({ ...d, kind: 'difference' }, { yaw: 1, pitch: 2, roll: 3 }, { timestamp: '2026-11-14T00:00:00.000Z' });
    expect(r.kind).toBe('difference');
    const p = r.provenance!;
    expect(p.op).toBe('rotate');
    expect(p.params['yaw']).toBe(1);
    expect(p.params['pitch']).toBe(2);
    expect(p.params['roll']).toBe(3);
    expect(p.params['order']).toMatch(/roll, then pitch, then yaw/);
    expect(p.params['target']).toBe('same');
    expect(p.params['interpolation']).toBe('bilinear');
    expect(provenanceChain(r)).toMatch(/rotate: yaw 1, pitch 2, roll 3 deg/);
  });
});

describe('invariants and tolerances', () => {
  const rel = (a: number, b: number) => Math.abs(a - b) / Math.abs(b);

  it('two successive rotations equal the single composed rotation (resampled once from the original)', () => {
    const a1 = { yaw: 4, pitch: -2, roll: 6 };
    const a2 = { yaw: -1.5, pitch: 3, roll: -2 };
    const twice = rotate(rotate(gauss, a1).dataset, a2);
    const total = anglesFromMatrix(multiplyMatrices(rotationMatrix(a2), rotationMatrix(a1)));
    const once = rotate(gauss, total);
    expect(twice.dataset.grid).toEqual(once.dataset.grid);
    twice.dataset.values.forEach((x, i) => {
      const y = once.dataset.values[i]!;
      if (Number.isNaN(y)) expect(x).toBeNaN();
      else expect(Math.abs(x - y)).toBeLessThan(1e-9 * GAUSS.peak);
    });
    const p = twice.dataset.provenance!.params;
    expect(p['composed']).toBe(true);
    const c = p['composedAngles'] as { yaw: number; pitch: number; roll: number };
    expect(c.yaw).toBeCloseTo(total.yaw, 9);
    expect(c.pitch).toBeCloseTo(total.pitch, 9);
    expect(c.roll).toBeCloseTo(total.roll, 9);
    expect(twice.report.composed).toBe(true);
  });

  it('rotate then inverse-rotate (composed) returns the original exactly', () => {
    const aim = { yaw: 3, pitch: -2, roll: 8 };
    const inv = anglesFromMatrix(transposeOf(rotationMatrix(aim)));
    const back = rotate(rotate(gauss, aim).dataset, inv).dataset;
    back.values.forEach((x, i) => expect(Math.abs(x - gauss.values[i]!)).toBeLessThan(1e-9 * GAUSS.peak));
  });

  // Tolerance 0.1% of peak: two bilinear resamplings of a smooth beam on a 3° grid measured 0.047% worst case.
  it('rotate then inverse-rotate WITHOUT composition stays within 0.1% of the peak, away from coverage edges (smooth beam, 3° grid)', () => {
    const aim = { yaw: 5, pitch: -4, roll: 10 };
    const inv = anglesFromMatrix(transposeOf(rotationMatrix(aim)));
    const back = rotate(rotate(smooth, aim).dataset, inv, { compose: false }).dataset;
    const peak = summarize(smooth).maxIntensity;
    let checked = 0;
    for (let h = -60; h <= 60; h += 3) {
      for (let v = -60; v <= 60; v += 3) {
        const x = sample(back, h, v);
        const expected = sameBeam(...dirTypeA(h, v));
        expect(Math.abs(x - expected) / peak).toBeLessThan(1e-3);
        checked++;
      }
    }
    expect(checked).toBe(41 * 41);
  });

  // Tolerance 0.05%: measured −0.004% (bilinear resampling preserves the integral to second order).
  it('flux is conserved within 0.05% when the beam stays inside coverage (Gaussian, extended grid)', () => {
    const { dataset: r, report } = rotate(gauss, { yaw: -4, pitch: 2, roll: 7 }, { target: 'extended' });
    expect(rel(flux(r), flux(gauss))).toBeLessThan(0.0005);
    expect(report.fluxBefore).toBeCloseTo(flux(gauss), 9);
    expect(report.fluxAfter).toBeCloseTo(flux(r), 9);
    expect(report.fluxChangePercent).toBeCloseTo((100 * (flux(r) - flux(gauss))) / flux(gauss), 9);
  });

  it('stops with a clear error if the extended grid would be too large', () => {
    expect(() => rotate(gauss, { yaw: 0, pitch: 60, roll: 0 }, { target: 'extended', maxPoints: 1000 })).toThrow(/too large|nodes/i);
  });
});

function transposeOf(m: number[]): number[] {
  return [m[0]!, m[3]!, m[6]!, m[1]!, m[4]!, m[7]!, m[2]!, m[5]!, m[8]!];
}

describe('planRotation (what a rotation will do, before running it)', () => {
  it('pure yaw on an unrotated dataset is the exact-shift fast path', () => {
    expect(planRotation(gauss, { yaw: 3, pitch: 0, roll: 0 })).toMatchObject({ composed: false, fastPath: true });
  });
  it('a yaw on an already rotated dataset composes and is NOT a fast path if the total has pitch or roll', () => {
    const first = rotate(gauss, { yaw: -5, pitch: 4, roll: 10 }).dataset;
    const p = planRotation(first, { yaw: 3, pitch: 0, roll: 0 });
    expect(p.composed).toBe(true);
    expect(p.fastPath).toBe(false);
    expect(p.total.yaw).toBeCloseTo(-2, 9);
    expect(p.originalName).toBe('gauss.ies');
  });
  it('yaw then yaw composes to a pure yaw: fast path from the original', () => {
    const first = rotate(gauss, { yaw: 2, pitch: 0, roll: 0 }).dataset;
    expect(planRotation(first, { yaw: 3, pitch: 0, roll: 0 })).toMatchObject({ composed: true, fastPath: true });
    const { dataset } = rotate(first, { yaw: 3, pitch: 0, roll: 0 });
    expect(dataset.grid.h[0]).toBe(gauss.grid.h[0]! + 5);
    expect(Array.from(dataset.values)).toEqual(Array.from(gauss.values));
  });
});
