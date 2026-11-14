import { describe, expect, it } from 'vitest';
import { mk } from './helpers';
import { RoadError, axisValues, makeEvaluator } from '../core/road/illuminance';
import { laneLayout, lampPair, mirrorAim, parseVehiclePreset } from '../core/road/setup';

const presets = import.meta.glob<unknown>('../data/presets/vehicles/*.json', { import: 'default', eager: true });

describe('lane layout', () => {
  it('right-hand traffic, two lanes, own lane at the kerb, centred', () => {
    const r = laneLayout({ laneWidth: 3.5, lanes: 2, trafficSide: 'right', ownLane: 1, offset: 0 });
    expect(r.lines).toEqual({ 'vehicle-axis': 0, 'lane-centre': 0, 'lane-left-edge': -1.75, 'lane-right-edge': 1.75 });
    expect(r.road).toEqual({ yMin: -5.25, yMax: 1.75 });
    expect(r.markings).toEqual([
      { y: -5.25, kind: 'edge' },
      { y: -1.75, kind: 'lane' },
      { y: 1.75, kind: 'edge' },
    ]);
  });

  it('left-hand traffic puts lane 1 on the left; the offset moves the vehicle right of the lane centre', () => {
    const r = laneLayout({ laneWidth: 3.5, lanes: 2, trafficSide: 'left', ownLane: 1, offset: 0.3 });
    expect(r.lines['lane-centre']).toBeCloseTo(-0.3, 12);
    expect(r.lines['lane-left-edge']).toBeCloseTo(-2.05, 12);
    expect(r.lines['lane-right-edge']).toBeCloseTo(1.45, 12);
    expect(r.road.yMin).toBeCloseTo(-2.05, 12);
    expect(r.road.yMax).toBeCloseTo(4.95, 12);
  });

  it('three lanes, driving in the middle one', () => {
    const r = laneLayout({ laneWidth: 3, lanes: 3, trafficSide: 'right', ownLane: 2, offset: 0 });
    expect(r.road).toEqual({ yMin: -4.5, yMax: 4.5 });
    expect(r.markings.map((m) => m.y)).toEqual([-4.5, -1.5, 1.5, 4.5]);
  });

  it('every value must be entered', () => {
    expect(() => laneLayout({ laneWidth: null, lanes: 2, trafficSide: 'right', ownLane: 1, offset: 0 })).toThrow(/lane width/);
    expect(() => laneLayout({ laneWidth: 3.5, lanes: 2, trafficSide: null, ownLane: 1, offset: 0 })).toThrow(/traffic side/);
    expect(() => laneLayout({ laneWidth: 3.5, lanes: 2, trafficSide: 'right', ownLane: 3, offset: 0 })).toThrow(/own lane/);
    expect(() => laneLayout({ laneWidth: 3.5, lanes: 2, trafficSide: 'right', ownLane: 1, offset: null })).toThrow(/position in the lane/);
  });
});

describe('lamp pair', () => {
  const asym = mk(axisValues({ min: -40, max: 40, step: 1 }), axisValues({ min: -10, max: 5, step: 0.5 }), (h, v) => 100 + 1e4 * Math.exp(-((h - 4) ** 2) / 30 - (v + 1) ** 2));
  const aimL = { yaw: -1, pitch: -0.57, roll: 0 };

  it('places the lamps at ± separation / 2 and the mounting height; left is negative y', () => {
    const [l, r] = lampPair({ left: asym, right: null, mirror: 'right', separation: 1.4, height: 0.65, x: -0.1, aimLeft: aimL, aimRight: mirrorAim(aimL) });
    expect(l!.position).toEqual({ x: -0.1, y: -0.7, height: 0.65 });
    expect(r!.position).toEqual({ x: -0.1, y: 0.7, height: 0.65 });
    expect(l!.mirror).toBe(false);
    expect(r!.mirror).toBe(true);
    expect(r!.dataset).toBe(asym);
    expect(r!.aim).toEqual({ yaw: 1, pitch: -0.57, roll: 0 });
    expect(Object.is(r!.aim.roll, -0)).toBe(false);
  });

  it('one file mirrored for the other side gives a pair symmetric about the centre line', () => {
    const ev = makeEvaluator(lampPair({ left: asym, right: null, mirror: 'right', separation: 1.4, height: 0.65, x: 0, aimLeft: aimL, aimRight: mirrorAim(aimL) }));
    for (const [x, y] of [[20, 1], [35, 3], [50, 0.5]] as const) expect(ev([x, -y, 0])).toBeCloseTo(ev([x, y, 0]), 9);
  });

  it('two separate files are used as given', () => {
    const other = mk([-40, 40], [-10, 5], () => 50);
    const [l, r] = lampPair({ left: asym, right: other, mirror: 'none', separation: 1.2, height: 0.7, x: 0, aimLeft: aimL, aimRight: aimL });
    expect(l!.dataset).toBe(asym);
    expect(r!.dataset).toBe(other);
    expect(r!.mirror).toBe(false);
  });

  it('no hidden defaults: separation, height, position and aim must be entered', () => {
    const base = { left: asym, right: null, mirror: 'right' as const, separation: 1.4, height: 0.65, x: 0, aimLeft: aimL, aimRight: aimL };
    expect(() => lampPair({ ...base, height: null })).toThrow(/mounting height/);
    expect(() => lampPair({ ...base, separation: null })).toThrow(/separation/);
    expect(() => lampPair({ ...base, x: null })).toThrow(/position x/);
    expect(() => lampPair({ ...base, aimRight: null })).toThrow(/right lamp aim/);
    expect(() => lampPair({ ...base, aimLeft: { yaw: 0, pitch: Number.NaN, roll: 0 } })).toThrow(/left lamp aim/);
    expect(() => lampPair({ ...base, separation: -1 })).toThrow(RoadError);
  });
});

describe('vehicle presets', () => {
  it('there is exactly one preset, labelled EXAMPLE, and it is valid', () => {
    const entries = Object.entries(presets);
    expect(entries.length).toBe(1);
    const [file, obj] = entries[0]!;
    expect(file).toMatch(/EXAMPLE/);
    const p = parseVehiclePreset(obj);
    expect(p.example).toBe(true);
    expect(p.label).toMatch(/^EXAMPLE/);
  });

  it('rejects a preset with missing values', () => {
    expect(() => parseVehiclePreset({ label: 'x', example: true, lamps: { height: null } })).toThrow(/lamps\.height/);
  });
});

describe('points text', () => {
  it('parses x y z plane [name], skips comments, reports bad lines', async () => {
    const { parsePoints } = await import('../core/road/setup');
    const r = parsePoints('# comment\n25 -1.75 0 road\n50; 2; 1,2; vertical; sign left\n\n10 0 road');
    expect(r.points).toEqual([
      { name: 'P1', point: [25, -1.75, 0], normal: [0, 0, 1] },
      { name: 'sign left', point: [50, 2, 1.2], normal: [-1, 0, 0] },
    ]);
    expect(r.errors).toEqual(['line 5: expected "x y z road|vertical [name]", got "10 0 road"']);
  });
});
