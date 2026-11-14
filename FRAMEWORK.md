# IES Workbench — Development Framework

Working name: **beamLab** . Date: 2026-11-13. Author: Jalib Akther.

This document is the instruction set for building the tool. It is written so it can be placed in the repo root (as `FRAMEWORK.md` or `CLAUDE.md`) and followed phase by phase with Claude Code.

---

## 1. Purpose and scope

One tool to **open**, **evaluate** and **manipulate** photometric IES (LM-63) files for automotive lamps.

| Pillar | Functions |
|---|---|
| Open | Parse IES, show metadata, view intensity distribution, export |
| Evaluate | Regulation check (test points, zones, lines) and road performance check (reusing Road-illuminate) |
| Manipulate | Add, subtract, multiply, divide, rotate/aim, cut-off analysis |

Out of scope for v1: near-field effects, colour data, EULUMDAT/LDT and raw goniometer formats (keep the reader interface open so they can be added later), HSPR scoring (link out to HSPRevaluate instead of duplicating it).

## 2. Design principles

1. **Local processing only.** IES files are sensitive. Everything runs in the browser; no upload, no backend, no analytics on file content.
2. **Core is a pure library.** All parsing, maths and checks live in a `core/` package with no DOM or plotting dependency. The UI only calls the core. This is what makes Road-illuminate reuse and unit testing possible.
3. **One canonical in-memory model.** Every file, whatever its photometric type or symmetry, is converted on load to one internal representation. All operations work on that and nothing else.
4. **Non-destructive.** Operations never modify a dataset; they create a new derived dataset that records its provenance (operation, inputs, parameters).
5. **Regulations are data, not code.** Test points, zones and limits live in JSON files. The check engine is generic.
6. **Every number is traceable.** Any result shown can be traced to the source file, the operation chain, and the interpolation method used.

## 3. Architecture

```
UI layer        Workspace · Viewer · Evaluate panel · Manipulate panel · Report
                    │
App state       Dataset registry (source + derived), selection, settings
                    │
Core library    io/  model/  geometry/  ops/  analysis/  regs/  road/
                    │
Data            regulations/*.json   presets/*.json   test fixtures/*.ies
```

### 3.1 Canonical data model

```ts
PhotometricDataset {
  id, name
  kind: 'intensity' | 'ratio' | 'mask'     // only 'intensity' may be exported as IES
  grid: { h: number[], v: number[] }        // degrees, Type A (H-V), ascending
  values: Float64Array                      // row-major [v][h]; cd for 'intensity'
  coverage: { hMin, hMax, vMin, vMax }      // where data is real, not padded
  meta: { keywords, lumens, multiplier, watts, dimensions, sourceType, sourceFormat }
  provenance: { op, inputs: id[], params, timestamp } | null
}
```

Rules:

- Internal convention is **Type A, H-V**, polar axis vertical: H positive to the right, V positive up, as seen from the lamp looking forward. Direction vector: `x(forward) = cos V · cos H`, `y(right) = cos V · sin H`, `z(up) = sin V`.
- The candela multiplier and ballast factors are applied on load, so `values` are always absolute candela.
- Symmetric files (for example H from 0 to 90 only) are expanded to the full range on load.
- Points outside `coverage` are `NaN`, never silently zero. Each operation states its policy for `NaN`.

### 3.2 Geometry service

All coordinate work goes through unit direction vectors:

- `anglesToVector(type, h, v)` and `vectorToAngles(type, vec)` for Types A, B and C.
- `sample(dataset, h, v, method)` with bilinear interpolation as default and bicubic as an option.
- `resample(dataset, targetGrid)`.
- `solidAngleWeights(grid)` for flux integration (`dΩ = cos V · dV · dH` in Type A).

Type B and Type C conversions must be derived from the axis definitions in LM-63 / CIE 121 and proven by round-trip tests (A → B → A, A → C → A) before they are trusted. Do not hand-copy formulas without a test.

## 4. Open module

**Parser (`io/ies.ts`)**

- Accept LM-63-1986 (no header line), 1991, 1995, 2002 and 2019 headers.
- Read keywords, `TILT=` (NONE / INCLUDE / file reference — warn if not NONE), then the numeric block as a free-format token stream (values may be split across lines by spaces or commas).
- Numeric block: lamp count, lumens per lamp, candela multiplier, number of vertical angles, number of horizontal angles, photometric type (1 = C, 2 = B, 3 = A), units, width, length, height; then ballast factor, future-use factor, input watts; then vertical angles, horizontal angles, candela values (one set of vertical values per horizontal angle).
- Validate: token count matches declared sizes, angles strictly ascending, no negative candela. Return structured warnings, do not throw on recoverable issues.

**On load**: convert to the canonical model, compute a summary (max intensity and its H-V position, total flux in the covered region, angular range, grid step).

**Viewer**

- Isocandela plot in H-V (linear and log scale, user contour levels).
- False-colour map, H and V cross-sections at any cursor position, cursor read-out in cd.
- Overlay of two datasets and a difference view.

**Export**: IES LM-63-2002 Type A, with provenance written into keyword lines; CSV matrix; PNG of plots.

## 5. Evaluate module

### 5.1 Regulation check

Generic engine (`regs/engine.ts`) driven by JSON definitions.

```json
{
  "id": "UN-R149-ClassC-LHT-or-RHT",
  "title": "...", "revision": "...", "source": "document + paragraph",
  "aim": { "type": "cutoff", "nominalV": -0.57, "allowReaim": { "h": 0.5, "v": 0.25 } },
  "elements": [
    { "type": "point", "name": "...", "h": 0, "v": 0, "min": null, "max": null },
    { "type": "zone",  "name": "...", "polygon": [[h,v], ...], "max": null },
    { "type": "line",  "name": "...", "from": [h,v], "to": [h,v], "min": null },
    { "type": "ratio", "name": "...", "a": "pointName", "b": "pointName", "min": null }
  ]
}
```

- Element types: point, line segment, zone (polygon), ratio between elements, and "max anywhere in zone".
- Result per element: measured value, limit, margin in cd and in percent, pass/fail. Plus an overall verdict and the worst-margin element.
- Overlay all elements on the isocandela plot, coloured by result.
- Optional re-aim search: within the tolerance the regulation allows, find the aim that maximises the worst margin, and report the aim used.
- Scaling inputs: number of lamps, measured vs nominal flux, test voltage factor, so one file can be checked under stated conditions.

**Important:** the numeric limit tables must be transcribed from the current official regulation text and verified by you; the build must not invent or recall them. Start by migrating the tables already validated in PIRA (signal lamps, R148 / FMVSS 108) and beamTolerance (R149 Class C low beam), then add others one regulation at a time, each with a `source` and `revision` field.

### 5.2 Performance check (road illumination)

Reuse Road-illuminate rather than rewriting it:

1. Extract Road-illuminate's calculation into `core/road/` (or a small shared package) with a clean function: `roadIlluminance(lamps[], roadGrid, options)`, where each lamp is `{ dataset, position (x, y, height), aim (yaw, pitch) }`.
2. Road-illuminate then imports the same module, so both tools stay in sync.
3. Illuminance at a road point is `E = I(H,V) · cos(θ) / d²`, with `θ` the incidence angle on the evaluated plane and `d` the lamp-to-point distance. Support the horizontal road surface and vertical planes (for sign and pedestrian visibility).

Outputs: isolux plot with lane markings, reach of chosen isolux lines (for example 1 lx and 3 lx) on the lane centre and both edges, beam width at set distances, and a requirements table (customer spec as JSON, same engine idea as 5.1 but in road coordinates).

## 6. Manipulate module

All binary operations follow one pipeline: **align → resample to a common grid → operate → tag provenance**.

Common grid = finest step of the inputs; extent = union or intersection (user choice, default intersection). Outside an input's coverage the value is `NaN` unless the user chooses "treat as zero".

| Operation | Definition | Typical use | Guard |
|---|---|---|---|
| Add | `A + B` (optionally weighted) | Combine modules or functions (low beam + high beam) | Far-field assumption: lamp offset is ignored. Use the road module when positions matter |
| Subtract | `A − B` | Isolate one module's contribution; sim − measurement | Negative results kept in a difference view; clamp to zero only on explicit request before IES export |
| Multiply | `A × k` or `A × B` | Flux scaling, dimming, lens transmission map | `A × B` requires B to be `kind: 'ratio'` or `'mask'` |
| Divide | `A / B` | Intensity ratio maps (stop/tail, sim/measurement) | Result is `kind: 'ratio'`; floor on denominator (user threshold) → `NaN` below it; not exportable as IES |
| Rotate / aim | 3D rotation of the distribution: yaw, pitch, roll | Re-aim, mounting tilt, levelling studies | See below |
| Cut-off analysis | See 6.2 | Low beam sharpness and position | Needs fine vertical resolution |

### 6.1 Rotate / aim

- Implement as a true rotation on the sphere: for each target grid direction, apply the inverse rotation to its direction vector, convert back to angles, and sample the source. Never implement aim as a simple shift of the V axis: that is only exact on the H = 0 line.
- In the Type A convention, yaw about the vertical axis is an exact H shift; use this as a test case.
- Report how much of the target grid fell outside source coverage after rotation.
- Provide "aim to cut-off" as a convenience: run cut-off analysis, then rotate so the cut-off sits at the chosen nominal position.

### 6.2 Cut-off analysis

- Vertical scan at a chosen H (default per the regulation selected), computing the gradient `G = log10 I(V) − log10 I(V + 0.1°)`.
- Cut-off position = V of maximum G. Report G max and compare with the regulation's minimum and maximum sharpness limits (take the scan position and limits from the regulation text; store them in the regulation JSON, not in code).
- Repeat the scan across a range of H to trace the cut-off line: horizontal part, elbow/kink position, shoulder angle, and straightness (deviation from a fitted line).
- If the file's vertical step near the cut-off is coarser than 0.1°, show a clear warning: the gradient is then an interpolation artefact, not a measurement.
- Outputs: scan plot (I and G vs V), cut-off line overlaid on the isocandela plot, summary table.

## 7. User interface

Single-page layout, three regions:

- **Left: Workspace.** Loaded and derived datasets, each with a visibility toggle, summary, and provenance chain. Drag and drop to load.
- **Centre: Viewer.** Isocandela / false-colour / road view tabs, cursor read-out, overlays.
- **Right: Task panel** with tabs *Info*, *Evaluate* (regulation selector, aim options, results table), *Road* (mounting inputs, results), *Manipulate* (operation picker, inputs, preview, "Create dataset"), *Cut-off*.

A *Report* action exports the current evaluation as a printable page: file identity, operation chain, settings, results table, plots.

Footer: copyright and licence line, plus a "files are processed locally" statement.

## 8. Repository structure

```
/core
  /io          ies.ts, csv.ts, export.ts
  /model       dataset.ts, provenance.ts
  /geometry    coords.ts, interpolate.ts, resample.ts, rotate.ts, flux.ts
  /ops         arithmetic.ts, aim.ts
  /analysis    cutoff.ts, summary.ts
  /regs        engine.ts, schema.ts
  /road        illuminance.ts            (shared with Road-illuminate)
/data
  /regulations *.json                    (each with source + revision)
  /presets     vehicle mounting presets
/ui            workspace, viewer, panels, report
/tests
  /fixtures    synthetic *.ies with known answers
  *.test.ts
FRAMEWORK.md   README.md   LICENSE
```

## 9. Build phases

Finish and test each phase before starting the next.

| Phase | Deliverable | Done when |
|---|---|---|
| 0. Setup | Repo, build, test runner, CI deploy to GitHub Pages | Empty app deploys; one passing test |
| 1. Core I/O and model | IES parser, canonical model, Type A/B/C conversion, flux, export | Round-trip (load → export → load) reproduces values; A/B/C round-trips pass |
| 2. Viewer | Workspace, isocandela and false-colour plots, sections, cursor | A real file displays correctly against a reference viewer |
| 3. Arithmetic | Add, subtract, multiply, divide with provenance | Synthetic cases match hand calculation; coverage/NaN rules hold |
| 4. Rotate / aim | 3D rotation and resampling | Yaw equals exact H shift; rotate then inverse-rotate returns the original within tolerance; flux conserved |
| 5. Cut-off analysis | Gradient scan, cut-off line trace | Synthetic beam with a known cut-off position and gradient is recovered |
| 6. Regulation engine | JSON schema, engine, overlay, first two regulations migrated from PIRA and beamTolerance | Results match those tools on the same files |
| 7. Road performance | Shared road module, isolux view, requirements check | Matches Road-illuminate output on the same inputs |
| 8. Report and polish | Printable report, presets, error messages, docs | A full evaluation can be exported and understood by someone else |

## 10. Validation and tests

- **Synthetic fixtures** generated by script with analytic answers: uniform source (known flux), Gaussian spot (known peak and position), step cut-off with a defined gradient, asymmetric pattern (catches left/right and up/down flips).
- **Sign convention test**: an asymmetric fixture must display with the hot spot on the correct side. This is the most common bug class in IES tools.
- **Invariants**: `A + B − B = A`; `(A × k) / k = A`; rotation conserves flux within interpolation tolerance; export then import is lossless to the written precision.
- **Cross-tool checks**: same file, same settings, compared against PIRA, beamTolerance, Road-illuminate and beamCorrelate.
- **Real files** stay out of the repo. Keep them in a git-ignored local folder.

## 11. Decisions to settle before starting

1. **Stack.** Default proposal: TypeScript, Vite, Vitest, Plotly, static deploy to GitHub Pages. If Road-illuminate is plain JavaScript, either match it or convert its calculation core as part of Phase 7.
2. **Shared code.** Copy the road module into this repo, or publish a small shared `lighting-core` package that all your tools import. The second is more work now and much less later.
3. **Which regulations first.** Suggested order: R149 Class C low beam, R149 high beam, R148 signal functions, FMVSS 108.
4. **Default interpolation.** Bilinear is transparent and conservative; bicubic looks smoother but can overshoot near a cut-off.
5. **Licence and visibility.** Public like the other tools, or private until the regulation tables are verified.

## 12. Kickoff prompt for Claude Code

> Read FRAMEWORK.md fully. We are building this tool phase by phase. Start with Phase 0 and Phase 1 only. Rules: keep `core/` free of any DOM or plotting code; all files are processed locally in the browser; write the synthetic fixture generator and tests before the implementation of each function; do not invent regulation limit values — leave them `null` in JSON until I supply them; follow the Type A H-V sign convention in section 3.1 and add the sign-convention test. Stop at the end of Phase 1 and show me the test results and any open questions before continuing.
