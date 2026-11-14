import { describe, expect, it } from 'vitest';
import { mk } from './helpers';
import { axisValues } from '../core/road/illuminance';
import { laneLayout } from '../core/road/setup';
import { parseRequirements } from '../core/road/requirements';
import { roadResultsToCsv, runRoad, type RoadRunInput } from '../core/road/results';

const I = 10000;
const iso = mk(axisValues({ min: -180, max: 180, step: 10 }), axisValues({ min: -90, max: 90, step: 10 }), () => I, { name: 'iso' });
const base: RoadRunInput = {
  lamps: [{ name: 'L', dataset: iso, position: { x: 0, y: 0, height: 1 }, aim: { yaw: 0, pitch: 0, roll: 0 } }],
  grid: { x: { min: 0, max: 60, step: 0.5 }, y: { min: -5, max: 5, step: 0.5 } },
  outside: 'unknown',
  levels: [3, 1],
  layout: laneLayout({ laneWidth: 3.5, lanes: 2, trafficSide: 'right', ownLane: 1, offset: 0 }),
  widthDistances: [10],
  widthLevel: 5,
  points: [{ name: 'p', point: [20, 0, 0] }],
  requirements: parseRequirements({ id: 'r', title: 'R', source: null, revision: null, verified: false, elements: [{ type: 'reach', name: 'r1', line: 'lane-left-edge', level: 1, min: 10 }] }),
};

describe('runRoad and the results CSV', () => {
  it('runs every part: field, reach on the three lane lines per level, widths, points, requirements', () => {
    const r = runRoad(base);
    expect(r.field.values.length).toBe(121 * 21);
    expect(r.max).toEqual({ value: I, x: 0, y: 0 });
    expect(r.reaches.map((x) => `${x.level}@${x.line}`)).toEqual([
      '1@lane-centre', '1@lane-left-edge', '1@lane-right-edge', '3@lane-centre', '3@lane-left-edge', '3@lane-right-edge',
    ]);
    expect(r.reaches[0]!.reach!).toBeCloseTo(Math.sqrt((I / 1) ** (2 / 3) - 1), 1);
    expect(r.widths[0]!.width).not.toBeNull();
    expect(r.points[0]!.value).toBeCloseTo(I / 401 ** 1.5, 10);
    expect(r.requirements!.elements[0]!.status).toBe('pass');
  });

  it('without a lane setup, reach is on the vehicle axis and lane-line requirements are not evaluated', () => {
    const r = runRoad({ ...base, layout: null });
    expect(r.reaches.map((x) => x.line)).toEqual(['vehicle-axis', 'vehicle-axis']);
    expect(r.requirements!.elements[0]).toMatchObject({ status: 'not-evaluated', reason: 'line lane-left-edge is not defined: enter the lane setup' });
  });

  it('CSV has the lamp, reach, width, point, maximum and requirement sections', () => {
    const csv = roadResultsToCsv(base, runRoad(base));
    for (const s of ['section,lamp,dataset', 'reach,lane centre,0,1,', 'width,10,5,', 'point,p,20,0,0,road,', 'maximum,10000 lx at x 0 m y 0 m', 'element,type,status', 'r1,reach,pass']) expect(csv).toContain(s);
  });
});
