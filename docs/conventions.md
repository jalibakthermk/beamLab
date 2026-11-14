# Conventions

How beamLab represents directions, angles, rotations and missing data. The code is the reference; the file named in each section holds the definition and its tests.

## Axes

Vehicle frame: **x forward, y right, z up**. The frame is right-handed (forward × right = up).

- Angular data is in degrees.
- Road geometry is in metres. The road surface is z = 0, and the origin is on the ground below the centre of the vehicle front.

Defined in `core/geometry/coords.ts` and `core/road/illuminance.ts`.

## Photometric angles (canonical Type A, H-V)

Every dataset is held as Type A H-V with a vertical polar axis.

| Angle | Positive direction | Seen from |
|---|---|---|
| H | right | the lamp, looking forward |
| V | up | the lamp, looking forward |

Direction vector:

```
x (forward) = cos V · cos H
y (right)   = cos V · sin H
z (up)      = sin V
```

Inverse: V = asin(z), H = atan2(y, x). Values are stored row-major `[v][h]`, both axes ascending, in absolute candela (the file's multiplier, ballast and ballast-lamp factors are applied on load).

**Left and right in regulations:** L means negative H, R positive H, U positive V and D negative V.

## Yaw, pitch and roll

| Angle | Axis | Positive direction | Matrix |
|---|---|---|---|
| Yaw ψ | z | beam turns right (+H) | [[cψ, −sψ, 0], [sψ, cψ, 0], [0, 0, 1]] |
| Pitch θ | y | beam turns up (+V) | [[cθ, 0, −sθ], [0, 1, 0], [sθ, 0, cθ]] |
| Roll φ | x | clockwise seen from the lamp (up → right) | [[1, 0, 0], [0, cφ, sφ], [0, −sφ, cφ]] |

- **Order:** roll, then pitch, then yaw, so **R = Yaw · Pitch · Roll**.
- **What R does:** it moves beam directions. A feature at direction d is at R·d after the rotation.
- **How it is applied:** rotation is a true rotation on the sphere. The rotated value at direction t is the source sampled at Rᵀ·t; it is never a shift of the V axis.
- **Exception:** a pure yaw keeps H within ±180°, so it is applied as an exact H shift.
- **Pitch from a percentage:** pitch = atan(percent / 100). For example, 1 % down is −0.573°.

Defined in `core/geometry/rotate.ts`.

**Road lamps** use the same signs. A lamp ray with vehicle direction u leaves the lamp at lamp-frame direction Rᵀ·u.

## Type B and Type C files (assumption)

LM-63 defines Types B and C relative to the luminaire, not the vehicle. beamLab maps them onto the vehicle as follows:

- **Type B:**
  - H = 0, V = 0 is forward.
  - The polar axis is lateral; H is positive to the right.
  - V is positive up.
- **Type C:**
  - The polar axis is vertical, with γ = 0 pointing down.
  - C = 0 is forward.
  - C increases counter-clockwise seen from above, so C = 90 is to the left.

This mapping is an **assumption**. It lives in one place (`AXIS_ASSUMPTIONS` in `core/geometry/coords.ts`), and every Type B or C file gives the warning `NON_TYPE_A_AXIS_ASSUMPTION`. Check it against a reference viewer before relying on Type B or C results.

Type B and C files are converted to Type A on load by bilinear resampling. The step is the finest step in the source. It is coarsened, with a warning, only if the grid would exceed 4 million points.

## Interpolation

Bilinear in H and V on the dataset grid (`sample()` in `core/geometry/interpolate.ts`). Corners with zero weight are ignored, so a node next to missing data still returns its exact value. Bicubic is not implemented.

## Missing data (coverage and NaN)

- Directions without data are `NaN` ("no data"), never zero. `NaN` is the authoritative mask; `coverage` is only the bounding box of real data.
- **Operations:** a `NaN` in any input gives `NaN` in the result, unless "treat as zero" is set for that input.
- **Regulation check:** an element that touches no-data directions is **not evaluated**, never passed.
- **Road:** a point is **unknown** when the ray from any lamp leaves that lamp's data. There are no partial sums. The share of unknown points is reported. "Treat directions without data as 0 lx" is an explicit option.
- **Requirements:** unknown areas never count as a pass. A result is decided only if the unknown part cannot change it.

## Common grid for operations on two datasets

Defined in `core/geometry/resample.ts` and `core/ops/arithmetic.ts`.

- **Identical grids** (nodes within 1e-6°): no resampling.
- **Different grids:** the merged set of both inputs' nodes inside the extent, plus the extent limits. No input loses resolution. A node that belongs to an input keeps that input's exact value; elsewhere the value is bilinear.
- **Extent:** the intersection of the coverages (default) or their union. With the intersection, coverages that do not overlap stop with an error.
- **Size guard:** a merged grid over 4 million nodes is refused.
- **Lamp offset:** operations treat both datasets as far-field. Use the road module when lamp positions matter.

## Status

| Status | Meaning |
|---|---|
| ✓ pass | Every limit is met on known data. |
| ✗ fail | At least one limit is missed on known data. |
| – not evaluated | A value or limit is missing, or the result depends on data that is not there. |
| ◐ incomplete | Overall verdict when any item is not evaluated. |

Status is always shown as text with an icon, not by colour alone.
