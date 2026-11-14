#!/usr/bin/env python3
"""
Generate the golden reference for tests/road-golden.test.ts by running the ORIGINAL
Road-illuminate calculation (import/road-illuminate/headlamp_road_illuminance.py,
unchanged) on the synthetic fixture tests/fixtures/road-beam-typeA.ies.

CI has no numpy and import/ is not committed, so the reference values are generated
once and stored in tests/fixtures/road/golden-road-illuminate.json.

    python3 scripts/golden-road-illuminate.py

The output records the Road-illuminate commit it was made from, the inputs of every
case in Road-illuminate's own conventions (y left, yaw + = left, aim in percent), and
each lamp's position and axes as Road-illuminate computed them.
"""
import json
import os
import subprocess
import sys
from argparse import Namespace

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REF = os.path.join(ROOT, "import", "road-illuminate")
sys.path.insert(0, REF)
import numpy as np  # noqa: E402
import headlamp_road_illuminance as ri  # noqa: E402

IES = os.path.join(ROOT, "tests", "fixtures", "road-beam-typeA.ies")
OUT = os.path.join(ROOT, "tests", "fixtures", "road", "golden-road-illuminate.json")

BASE = dict(ies=IES, ies_right=None, mirror_right=False, mirror_all=False, only=None,
            angle_system="azel", method="road", eval_height=0.0, height=0.65, separation=1.4,
            aim=-1.0, aim_unit="pct", toe=0.0, pitch=0.0, roll=0.0, pivot_x=0.0, scale=1.0, lumens=None)

CASES = [
    ("same file, aim -1 %", {}),
    ("toe-out 1.5 deg, mirrored right lamp", dict(toe=1.5, mirror_right=True)),
    ("vehicle pitch +0.4 deg about rear axle, roll +0.3 deg, aim -1.5 %", dict(aim=-1.5, pitch=0.4, pivot_x=-2.7, roll=0.3)),
    ("left lamp only, aim -0.57 deg", dict(only="left", aim=-0.57, aim_unit="deg", height=0.8)),
    ("vertical (HSPR) method, eval height 0.25 m, toe 1 deg", dict(method="vertical", eval_height=0.25, toe=1.0)),
]

XS = [5, 7.5, 10, 15, 20, 25, 30, 40, 50, 60, 75, 100]
YS = [-8, -5, -3.5, -2, -1, 0, 0.5, 1, 2, 3.5, 5, 8]
RANGE_Y = [0.0, -1.75, 1.75]
THRESHOLDS = [1.0, 3.0]
WIDTH_X = [10, 25, 50]


def main():
    commit = subprocess.run(["git", "-C", REF, "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
    cases = []
    for label, over in CASES:
        args = Namespace(**{**BASE, **over})
        lamps = ri.build_lamps(args)
        X, Y = np.meshgrid(XS, YS)  # rows = y, cols = x
        E = ri.road_illuminance(lamps, X, Y, args.angle_system, args.scale)
        ranges = {}
        for thr in THRESHOLDS:
            for y0 in RANGE_Y:
                r = ri.farthest_range(lamps, y0, thr, 200.0, args.angle_system, args.scale)
                ranges[f"{thr}@{y0}"] = None if r is None else float(r)
        widths = {}
        for thr in THRESHOLDS:
            for x0 in WIDTH_X:
                w = ri.width_at(lamps, x0, thr, 20.0, args.angle_system, args.scale)
                widths[f"{thr}@{x0}"] = None if w is None else [float(w[0]), float(w[1])]
        cases.append(dict(
            label=label,
            args={k: v for k, v in vars(args).items() if k != "ies"},
            lamps=[dict(name=lp["name"], pos=[float(v) for v in lp["pos"]], axes=np.asarray(lp["axes"]).tolist(),
                        aimV=float(lp["aimV"]), aimH=float(lp["aimH"]), zp=float(lp["zp"])) for lp in lamps],
            x=XS, y=YS, E=E.tolist(), range=ranges, width=widths,
        ))
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w") as fh:
        json.dump(dict(
            generator="scripts/golden-road-illuminate.py",
            reference="Road-illuminate headlamp_road_illuminance.py",
            referenceCommit=commit,
            ies="tests/fixtures/road-beam-typeA.ies",
            conventions="Road-illuminate: x forward, y LEFT, z up; yaw + = left; H + = right, V + = up; azel = Type A",
            rangeStep=0.05, widthStep=0.02, cases=cases), fh, indent=1)
    print(f"wrote {len(cases)} cases to {os.path.relpath(OUT, ROOT)} (Road-illuminate {commit[:7]})")


if __name__ == "__main__":
    main()
