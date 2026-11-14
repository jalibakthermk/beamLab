# core/road

Road illuminance (Phase 7, FRAMEWORK.md section 5.2), ported from Road-illuminate. No DOM code. Imports only `core/model` and `core/geometry`, so it can be extracted as a shared package.

- `illuminance.ts`: lamps (dataset, position, aim, mirror), `E = I · cos θ / r²` on the road, on vertical planes facing the vehicle and at single points; coverage policy (unknown or zero); grid size guard.
- `setup.ts`: lane layout and named lines, lamp pair helper (no defaults), vehicle preset validation, points text parser.
- `metrics.ts`: crossings, reach along a line, width at a distance, maximum, point values.
- `requirements.ts`: requirement file validator and checker (point, reach, width); unknown areas never pass.
- `results.ts`: one complete run on plain data (used by the Web Worker) and the results CSV.

Vehicle frame: x forward, y right, z up (m), road surface z = 0, origin on the ground below the vehicle front centre. Aim signs as in `core/geometry/rotate.ts`.
