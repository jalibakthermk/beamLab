# IES Workbench — Development Framework

Working name: **beamLab** . Date: 2026-11-13, revised 2026-11-14 after Phase 5. Author: Jalib Akther.

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
Data            data/regulations/*.json   data/presets/*.json   tests/fixtures/*.ies
```

### 3.1 Canonical data model

```ts
PhotometricDataset {
  id, name
  kind: 'intensity' | 'difference' | 'ratio' | 'mask'   // only 'intensity' may be exported as IES
  grid: { h: number[], v: number[] }        // degrees, Type A (H-V), ascending
  values: Float64Array                      // row-major [v][h]; cd for 'intensity'
  coverage: { hMin, hMax, vMin, vMax }      // bounding box of real data, not padded
  meta: { keywords, lumens, multiplier, ballastFactor, ballastLampFactor,
          watts, dimensions, sourceType, sourceFormat }
  provenance: { op, inputs: id[], params, timestamp, parents? } | null
}
```

Kinds:

| Kind | Values | Produced by | IES export |
|---|---|---|---|
| `intensity` | absolute cd, ≥ 0 | file import; add/scale/multiply of intensities; clamp | yes |
| `difference` | signed cd | subtract; add with a negative weight or a difference input | no (clamp first, on explicit request) |
| `ratio` | dimensionless | divide | no |
| `mask` | 0 or 1 | window mask | no |

Rules:

- Internal convention is **Type A, H-V**, polar axis vertical: H positive to the right, V positive up, as seen from the lamp looking forward. Direction vector: `x(forward) = cos V · cos H`, `y(right) = cos V · sin H`, `z(up) = sin V`. This is this tool's convention (the usual automotive reading: H about a vertical axis, then V as elevation). LM-63's own wording for Type A ties the polar axis to the luminaire's major axis and does not say "vertical"; do not quote LM-63 as the source of this formula.
- The candela multiplier, ballast factor and ballast-lamp photometric factor are applied on load, so `values` are always absolute candela. `meta` keeps all three factors as read, so the scaling is traceable.
- `lumens` is the total rated lamp lumens (lamps × lumens per lamp), or `null` for absolute photometry (`-1` in the file).
- Symmetric files are expanded to the full range on load: Type A/B with H 0..90 are mirrored to −90..90; Type C single-plane (rotational), 0..90 (quadrant), 0..180 and 90..270 (bilateral) are expanded to C 0..360 before conversion.
- Points without data are `NaN`, never silently zero. **`NaN` is the authoritative mask**; `coverage` is only the bounding box. For files converted from Type B or C the covered region is not a rectangle, so `NaN` can occur inside `coverage`. Each operation states its policy for `NaN`.
- Loading records provenance with `op: 'import'` (format, photometric type, TILT, flipH, symmetry expansion, and for Type B/C the conversion step, interpolation and axis assumptions).
- A rotation result also carries a runtime-only link `rotationOf` (original dataset and total rotation matrix; never exported), so a further rotation composes with it instead of resampling a resampled dataset.
- Operations record `op`, input ids, and in `params` the input names and every parameter (weights, scale factor, extent, coverage policy, denominator floor, whether resampling happened, result grid size). `parents` holds a snapshot of each input's id, name, kind and provenance, so the full chain back to the source files survives even when inputs are removed from the workspace. `provenanceChain(dataset)` (`model/provenance.ts`) returns that chain as readable ASCII text.

### 3.2 Geometry service

All coordinate work goes through unit direction vectors:

- `anglesToVector(type, h, v, axes?)` and `vectorToAngles(type, vec, axes?)` for Types A, B and C (for Type C, `h` is the C-plane angle and `v` is γ).
- `sample(dataset, h, v, method)` with bilinear interpolation as default. Bicubic is not implemented yet (see decision 4 in section 11); the `method` parameter is there so it can be added.
- `resample(dataset, targetGrid)` for Type A → Type A, and `resampleToTypeA(sourceGrid)` for converting Type B/C grids on load.
- `solidAngleWeights(grid)` and `flux(dataset)` for flux integration (`dΩ = cos V · dV · dH` in Type A). Each grid cell is integrated exactly for its bilinear interpolant, so a uniform intensity gives exactly `I · ΔH · (sin Vmax − sin Vmin)`. Cells with any `NaN` corner are skipped.

Type B and Type C conversions must be derived from the axis definitions in LM-63 / CIE 121 and proven by round-trip tests (A → B → A, A → C → A) **and** anchor tests with hand-computed directions before they are trusted. Round trips alone do not catch a consistent sign error. Do not hand-copy formulas without a test.

LM-63 defines Types B and C relative to the luminaire, not the vehicle. How their axes map onto vehicle axes is an **assumption**, kept in one documented config object (`AXIS_ASSUMPTIONS` in `core/geometry/coords.ts`); every Type B or C load gives a `NON_TYPE_A_AXIS_ASSUMPTION` warning. Current defaults, to be verified against a reference viewer with a real file:

- Type B: H = 0, V = 0 is forward; the polar axis is lateral with H positive to the right; V positive is up.
- Type C: polar axis vertical with γ = 0 down; C = 0 is forward; C increases counter-clockwise seen from above, so C = 90 is left.

Type B and C files are converted on load to the canonical Type A grid by bilinear resampling. The target step is the finest step found in the source, applied uniformly, and is recorded in provenance. The target grid spans only the area the source covers (its Type A bounding box plus a margin), and the step is increased (with a `RESAMPLE_STEP_COARSENED` warning) only if that area would exceed 4 million points. (Until 2026-11-14 the limit was applied to the full sphere, which coarsened typical automotive Type B files from 0.1° to 0.15625° and lowered the peak by about 5%.)

## 4. Open module

**Parser (`io/ies.ts`)**

- Accept LM-63-1986 (no header line), 1991, 1995, 2002 and 2019 headers.
- Read keywords, `TILT=` (NONE / INCLUDE / file reference — warn if not NONE), then the numeric block as a free-format token stream (values may be split across lines by spaces or commas).
- Numeric block: lamp count, lumens per lamp, candela multiplier, number of vertical angles, number of horizontal angles, photometric type (1 = C, 2 = B, 3 = A), units (1 = feet, 2 = meters), width, length, height; then ballast factor, ballast-lamp photometric factor ("future use" from 1995 on), input watts; then vertical angles, horizontal angles, candela values (one set of vertical values per horizontal angle).
- TILT=INCLUDE: the tilt block is parsed and skipped (tilt factors are not applied); TILT=<file>: the file is not loaded. Both give a warning.
- Validate and recover, with a structured warning (`code`, `message`, `severity`) for each issue instead of throwing:
  - token count differs from the declared sizes → missing candela set to `NaN`, extra tokens ignored;
  - angles not strictly ascending → sorted, each value kept with its angle; duplicate angles → first occurrence kept;
  - negative candela → kept as-is (not clamped);
  - angles outside the valid range for the type → dropped.
- Throw only when the file cannot be read at all (no TILT line, header or angles missing or non-numeric, angle count not a positive integer, unknown photometric type).
- Line 2 of the numeric block is "ballast factor, ballast-lamp photometric factor, input watts" in 1986/1991, but the second field is "future use" (should be 1) from 1995 on. It is applied in all versions, with a `FUTURE_USE_FACTOR_APPLIED` warning when a 1995+ file has a value other than 1.
- Accept angular ranges smaller than the LM-63 standard ranges (common in automotive files) with an info warning, and set coverage to the real range. Only H exactly 0..90 (Type A/B) is treated as laterally symmetric; 0..x with x < 90 is not expanded.
- Load option `flipH` (default false) mirrors left/right, because the sign of H differs between sources.

Interpretations of LM-63 where the standard is ambiguous each have a warning code; the full list is in `core/io/ies.ts` (`IesWarningCode`).

**On load**: convert to the canonical model. The summary (max intensity and its H-V position, total flux in the covered region, angular range, min/max grid step) is computed by `summarize(dataset)` in `analysis/summary.ts`, called by the UI after loading; the parser itself does not compute it.

**Viewer**

- Isocandela plot and false-colour map in H-V. Axes: H increasing to the right, V increasing upward, in degrees, equal scale on both axes, labelled "as seen from the lamp, looking forward".
- Linear and log intensity scale. On log scale, values ≤ 0 are drawn at a floor (one tenth of the smallest positive value) for display only, and the UI says so.
- Contour levels: automatic (`autoLevels` in `analysis/levels.ts`: nice linear steps, or 1-2-5 per decade on log) or a user-entered list in cd. Contour lines are computed in core (`analysis/contours.ts`, marching squares) and drawn as plain lines. Cells with any corner without data are skipped, so lines stop at the data edge and never bridge empty regions. (Plotly's contour trace was dropped: it interpolates every empty cell before drawing, which took about 2 s per level on converted Type B files.)
- Perceptually uniform colour scale (Viridis) with a colour bar labelled in cd. Regions without data (`NaN`) are left empty, never drawn as zero; the coverage box is drawn dotted.
- Zoom, pan, reset view, and "fit to data coverage".
- Cursor read-out of H, V and intensity, taken from `sample()` on the full-resolution data, not from the plot's own interpolation.
- Cross-sections: clicking sets a marker; intensity vs H at that V and intensity vs V at that H are shown under the main view (`analysis/section.ts`).
- Overlay of a second dataset: its contours dashed in a contrasting colour at the same levels, and its curves in both cross-sections. The overlay is drawn only on a dataset of the same kind.
- Difference view: with an overlay chosen, "Show difference" previews `subtract(selected, overlay)` without adding it to the workspace.
- Display per kind: `difference` uses a diverging blue–white–red scale centred on zero with a heavy zero contour; `ratio` uses a log scale centred on 1 with the same diverging colours and a heavy contour at 1, values without unit; `mask` is two-tone. Read-out, sections, probe and colour bars show the unit of the kind (cd, signed cd, none).
- Very fine grids are downsampled for display only (at most 500 grid lines per axis, `analysis/display.ts`); the UI states when this is active. Read-outs, sections and exports always use the full data.

**Export**: IES LM-63-2002 Type A (multiplier 1, lines under 132 characters), with source keywords kept, the readable provenance chain as `[_PROVENANCE_CHAIN]` keyword lines and the same as JSON in `[_PROVENANCE]`; CSV matrix (H as columns, V as rows, `NaN` as empty cells); PNG of plots.

IES export refuses datasets whose kind is not `'intensity'` or that contain `NaN`, because IES cannot represent missing values. Most datasets converted from Type B or C contain `NaN`, so they cannot be exported as IES until a crop or fill step exists (open decision 6 in section 11).

## 5. Evaluate module

### 5.1 Regulation check

Generic engine driven by JSON definitions: schema and hand-written validator `core/regs/schema.ts`, engine `core/regs/engine.ts`, aim modes `core/regs/reaim.ts`. Files live in `data/regulations/` (see its README); the test suite uses its own file of invented values in `tests/fixtures/regs/`, never copied there.

```json
{
  "id": "…", "title": "…", "source": "document + paragraph", "revision": "…",
  "verified": false,
  "units": "cd",
  "mirrorForLeftHandTraffic": false,
  "parameters": { "name": null },
  "aim": { "modes": ["as-loaded", "aim-to-cutoff", "re-aim-search"], "nominalCutoffV": null, "reaim": { "h": null, "v": null } },
  "elements": [
    { "type": "point",  "name": "…", "h": null, "v": null, "min": null, "max": null, "searchRadius": null, "ref": "table / paragraph" },
    { "type": "line",   "name": "…", "from": [null, null], "to": [null, null], "min": null },
    { "type": "zone",   "name": "…", "polygon": [[null, null], [null, null], [null, null]], "max": null },
    { "type": "ratio",  "name": "…", "a": "element", "b": "element", "min": null, "max": null },
    { "type": "global", "name": "…", "max": null }
  ]
}
```

- **File fields**: id, title, source, revision, `verified` (default false; the UI shows an "unverified limits" banner until true), `units` (`cd`, or `lx@25m` converted with cd = lx × 625 for limits and parameters; ratio limits are dimensionless), `mirrorForLeftHandTraffic` (files are written for right-hand traffic; left-hand traffic mirrors every element in H only if this is true), named `parameters`, the aim block (allowed modes, nominal cut-off V, permitted ± re-aim range in H and V) and the elements. Unknown values are `null`.
- **Elements**: point (optional search radius: the most favourable value within it counts), line (min or max along the whole segment), zone (polygon: max limit = "max anywhere", min limit = "min anywhere"), ratio between two named elements, global (maximum of the whole distribution). Each may carry its own `ref` (table or paragraph).
- **Limits**: a number in file units, `null`, or a percentage of a reference: `{ "percent": p, "of": "max" | { "element": name } | { "parameter": name } }`. The validator rejects unknown references and circular ones, and names every problem by its field path.
- **Engine**: intensity datasets only. Test conditions (scale factor and number of lamps) multiply the measured values and are stated in the result. Points use `sample()`; lines and zones are evaluated at the dataset's own nodes inside them plus their boundary at a 0.05° step (and every grid-line crossing), returning the worst value and its position. Per element: measured value, resolved limits, binding limit, margin in cd and percent, position, status pass / fail / not evaluated. Anything touching `NaN`, outside coverage, without a position or without a limit is "not evaluated", never a pass. Overall: pass only if every element passed; incomplete if any was not evaluated; otherwise fail. The worst-margin element (smallest margin in percent) is reported.
- **Aim modes**: as loaded; aim to cut-off first (Phase 5, at the file's nominal V, using the Cut-off tab's scan settings); re-aim search within the permitted range (9 × 9 coarse grid, then 6 refinement rounds, on a rotated view of the original so nothing is resampled twice; the final result uses one composed rotation). The search reports the aim found and the results at both the nominal and the optimised aim; it is disabled, with an explanation, if either range is null. Its precision is limited by the data grid: bilinear interpolation peaks at grid nodes.
- **Evaluate tab**: regulation, traffic side, aim mode, scale factor, number of lamps; a file picker loads a regulation JSON for the session (memory only); results table (sortable by margin, worst margin highlighted, rows select elements); all elements drawn on the isocandela view coloured by status, and clicking an element selects its row; overall verdict with aim and conditions; results CSV export.

**Important:** the numeric limit tables must be transcribed from the current official regulation text and verified by you; the build must not invent or recall them. Start by migrating the tables already validated in PIRA (signal lamps, R148 / FMVSS 108) and beamTolerance (R149 Class C low beam), then add others one regulation at a time, each with a `source` and `revision` field.

### 5.2 Performance check (road illumination)

Reuse Road-illuminate rather than rewriting it:

1. Extract Road-illuminate's calculation into `core/road/` (or a small shared package) with a clean function: `roadIlluminance(lamps[], roadGrid, options)`, where each lamp is `{ dataset, position (x, y, height), aim (yaw, pitch) }`.
2. Road-illuminate then imports the same module, so both tools stay in sync.
3. Illuminance at a road point is `E = I(H,V) · cos(θ) / d²`, with `θ` the incidence angle on the evaluated plane and `d` the lamp-to-point distance. Support the horizontal road surface and vertical planes (for sign and pedestrian visibility).

Outputs: isolux plot with lane markings, reach of chosen isolux lines (for example 1 lx and 3 lx) on the lane centre and both edges, beam width at set distances, and a requirements table (customer spec as JSON, same engine idea as 5.1 but in road coordinates).

## 6. Manipulate module

All binary operations follow one pipeline: **align → resample to a common grid → operate → tag provenance** (`ops/arithmetic.ts`, `geometry/resample.ts`). Every operation returns a new dataset; inputs are never modified. `NaN` in any input gives `NaN` in the result.

Common grid (`commonGrid`):

- **Identical grids** (same nodes within 1e-6°): no resampling; operate node by node.
- **Different grids**: the merged set of both inputs' grid nodes inside the extent (nodes closer than 1e-6° merged), plus the extent limits. No input loses resolution; values at a node that belongs to an input are that input's exact values, elsewhere bilinear `sample()`.
- **Extent**: intersection of the coverages (default) or union. Non-overlapping coverages with the intersection extent stop with a clear error.
- **Coverage policy**: where an input has no data (outside its coverage, or `NaN`), the value is `NaN`, unless "treat as zero" is set for that input.
- **Size guard**: a merged grid over 4 million nodes stops with a clear error instead of freezing the browser.

| Operation | Definition | Typical use | Guard |
|---|---|---|---|
| Add | `A + B` (optionally weighted) | Combine modules or functions (low beam + high beam) | Far-field assumption: lamp offset is ignored. Use the road module when positions matter |
| Subtract | `A − B` | Isolate one module's contribution; sim − measurement | Result is `kind: 'difference'`; negative values kept. `clampToIntensity` turns it into intensity (negatives → 0) only on explicit request, recorded in provenance |
| Scale | `A × k`, k ≥ 0 | Flux scaling, dimming | Negative k rejected; intensity stays intensity |
| Multiply | `A × B` | Lens transmission map, windowing | B must be `kind: 'ratio'` or `'mask'`; intensity × intensity rejected |
| Divide | `A / B` | Intensity ratio maps (stop/tail, sim/measurement) | Result is `kind: 'ratio'`; floor on denominator in cd (default 0.1% of B's peak) → `NaN` below it; not exportable as IES |
| Window mask | 1 inside H/V limits, 0 outside, on a chosen grid | Isolate a region (multiply by it) | `kind: 'mask'` |

Add: intensity + intensity with weights ≥ 0 gives intensity; a negative weight or a difference input gives a difference. Ratio and mask inputs cannot be added or subtracted.
| Rotate / aim | 3D rotation of the distribution: yaw, pitch, roll | Re-aim, mounting tilt, levelling studies | True rotation on the sphere; see 6.1 |
| Cut-off analysis | See 6.2 | Low beam sharpness and position | Needs fine vertical resolution |

### 6.1 Rotate / aim

`core/geometry/rotate.ts`. Conventions (axes as in 3.1: x forward, y right, z up; angles in degrees):

| Angle | Axis | Positive direction | Matrix |
|---|---|---|---|
| Yaw ψ | z | beam moves right (+H) | `[[cψ, −sψ, 0], [sψ, cψ, 0], [0, 0, 1]]` |
| Pitch θ | y | beam moves up (+V) | `[[cθ, 0, −sθ], [0, 1, 0], [sθ, 0, cθ]]` |
| Roll φ | x | clockwise as seen from the lamp looking forward (up → right → down) | `[[1, 0, 0], [0, cφ, sφ], [0, −sφ, cφ]]` |

- **Order**: roll first, then pitch, then yaw: `R = Yaw · Pitch · Roll`. R moves beam directions: a feature at direction d is at R·d after rotation.
- **True rotation on the sphere**: for each target node t, the value is the source sampled (bilinear) at Rᵀ·t. Never a shift of the V axis: that is only exact on the H = 0 line (pitching H 30°, V 0° by 5° does not give V 5°).
- **Fast path**: when the total rotation is a pure yaw (and H stays within ±180°), the result is an exact shift of the H grid: no resampling, values unchanged.
- **Target grid**: the input's grid (default) or the input's grid extended at its edge spacing to contain the rotated coverage (size guard: 4 million nodes). Target nodes whose source direction is outside the source coverage are `NaN`.
- **No accumulated blur**: if the input is itself a rotation result, the matrices are composed and the original is resampled once. Provenance records the requested and the composed angles. (Only direct rotation chains compose; a rotated dataset that went through another operation is resampled as it is.)
- **Inputs**: degrees; pitch may be entered as inclination in percent, converted with atan(p / 100) (1% = 0.573°).
- **Result**: same kind as the input; provenance records the angles, order, target grid option, interpolation, composition and the total matrix.
- **Report** with every rotation: share of target nodes outside the source coverage; flux before and after and the change in percent; peak value and position before and after. The UI warns when more than 5% of the target grid has no source data.
- "Aim to cut-off" (run cut-off analysis, then rotate so the cut-off sits at the chosen nominal position) is deferred to Phase 5.

### 6.2 Cut-off analysis

`core/analysis/cutoff.ts`; aim in `core/ops/aim.ts`.

- **Vertical scan** at a chosen H over a V window, at a configurable step (default 0.05°), computing `G(V) = log10 I(V) − log10 I(V + 0.1°)` from bilinear `sample()` on the full data. Intensity at or below zero gives G = NaN, never an error.
- **Cut-off position** = V of maximum G inside the window, refined between scan nodes with a 3-point parabola (the scan node is reported too). With a symmetric edge this is 0.05° below the edge centre, by the definition of G. "No cut-off" when G has no positive maximum.
- **Native V step**: the largest data V spacing inside the window is returned; above 0.1° a warning flag is set (G is then an interpolation artefact, not a measurement).
- **Secondary maxima**: other local maxima of G at or above 30% of Gmax (configurable), at least 0.2° from a stronger one, are reported so a noisy or double-edged file does not silently give the wrong cut-off.
- **Scan settings as data**: `data/presets/cutoff/*.json` (schema in `schema.json`): id, title, source, revision, traffic side, scan H, V window, minimum and maximum sharpness. Non-null preset values override the tab's settings. The template has every numeric field null; regulation values are entered only from the verified official text. With limits: pass/fail and margin (smallest distance to a limit); with null limits: values only.
- **Cut-off line trace**: the scan repeated across an H range (default −8..8° at 0.5°; scans with Gmax < 0.05 count as "no cut-off"). A continuous two-segment ("hinge") fit with a breakpoint searched at 0.01° gives: mean V and slope of the horizontal part, its straightness (max and RMS deviation from the fit), elbow H and V, shoulder angle and RMS residual. The traffic side decides which side is horizontal (RHT: left of the elbow, shoulder rising to the right; LHT mirrored). If the residual exceeds 0.05° (stepped or Z-shaped cut-off), or the "horizontal" part is inclined more than 5° (usually the wrong traffic side), the fit is flagged and only the raw trace is returned.
- **Aim to cut-off**: target cut-off V in degrees or percent down (−atan(p / 100); default 1% = −0.573°), optionally the elbow at H = 0 by yaw. Iterates analyse → rotate (section 6.1) → re-analyse until |cut-off V − target| ≤ 0.005° and |elbow H| ≤ 0.02°, or 8 steps. Rotations compose, so the original is resampled once. Returns the dataset, the correction (yaw, pitch) relative to the input, the residual and the step history; provenance records target and result. Bilinear resampling of a steep cut-off shifts the measured position by about 0.005°, which the iteration absorbs (the correction then differs from the purely geometric one by that amount).
- **Outputs (Cut-off tab)**: scan plot (I on a log axis and G against V, cut-off marked, limit lines when available); trace, fitted segments and elbow over the isocandela view; summary table (cut-off V in degrees and percent, Gmax, sharpness result, straightness, elbow, shoulder angle, native V step, warnings). With an overlay (or the original during an aim preview), both scans, traces and a side-by-side table.

## 7. User interface

Single-page layout, three regions:

- **Left: Workspace.** Loaded and derived datasets: one row each with name, peak intensity, grid step, warning badge, select, overlay toggle and remove; failed files show their error on their own row. Drag and drop anywhere on the page, or a file picker; several files at once. Provenance chain per dataset: later phase.
- **Centre: Viewer.** Isocandela / false-colour views (road view in Phase 7), cursor read-out, cross-sections, overlay, PNG export.
- **Right: Task panel** with tabs *Info* (summary, source format and photometric type, symmetry, keywords, full warning list, flipH toggle, IES and CSV export), *Evaluate* (regulation selector, aim options, results table), *Road* (mounting inputs, results), *Manipulate* (operation picker; inputs A and B from the workspace; weights or scalar; extent; coverage policy; denominator floor; window limits; a plain-language summary before running, including whether resampling will happen and the resulting grid size; Preview; "Create dataset" with an editable name; on Add the note "Assumes both files share the same aim and reference axis. Lamp position offset is ignored (far field)."), *Cut-off*. Tabs of later phases are shown disabled until built.

Preview: a result shown in the viewer but not in the workspace, with "Create dataset" (editable name) and "Close preview". Workspace rows show the kind and an expandable provenance chain; the Info panel shows the chain, and names can be edited there.

App state is a plain store without a framework (`ui/state/store.ts`): dataset registry, selected dataset, optional overlay dataset, view settings. Files are read with the browser File API and held in memory only; nothing is written to localStorage, IndexedDB or any other storage (a test checks every `ui/` file for this).

A *Report* action exports the current evaluation as a printable page: file identity, operation chain, settings, results table, plots.

Footer: copyright and licence line, plus a "files are processed locally" statement.

## 8. Repository structure

```
/core
  /io          ies.ts, csv.ts, export.ts, format.ts (shared number formatting)
  /model       dataset.ts, provenance.ts, version.ts
  /geometry    coords.ts, interpolate.ts, resample.ts, rotate.ts, flux.ts
  /ops         arithmetic.ts, aim.ts
  /analysis    summary.ts, section.ts, levels.ts, display.ts, contours.ts, cutoff.ts
  /regs        schema.ts, engine.ts, reaim.ts
  /road        illuminance.ts            (shared with Road-illuminate)
/data
  /regulations *.json                    (each with source + revision; README with the format)
  /presets     cutoff/ (scan settings: schema.json, template.json); vehicle mounting presets (later)
/ui            main.ts, state/store.ts, workspace.ts, viewer.ts, info.ts (task panel),
               manipulate.ts, cutoff.ts (Cut-off tab), evaluate.ts (Evaluate tab), plotly.ts (minimal Plotly bundle), report (later)
/tests
  /fixtures    synthetic *.ies with known answers, and generate.ts that writes them
  *.test.ts
/scripts       write-fixtures.mjs           (npm run fixtures)
FRAMEWORK.md   README.md   LICENSE
```

Fixtures are generated, never edited by hand: change `tests/fixtures/generate.ts` and run `npm run fixtures`. A test fails if the committed files differ from the generator output.

## 9. Build phases

Finish and test each phase before starting the next.

Status (2026-11-14): Phases 0–4 done and deployed (Type B/C axis mapping still to be checked against a reference viewer, decision 7). Phases 5 and 6 implemented and tested (366 tests passing), awaiting review. No regulation data yet: data/regulations/ is empty until the source files are supplied (import/ was not present); cut-off sharpness limits are null for the same reason.

| Phase | Deliverable | Done when |
|---|---|---|
| 0. Setup | Repo, build, test runner, CI deploy to GitHub Pages | Empty app deploys; one passing test |
| 1. Core I/O and model | IES parser, canonical model, Type A/B/C conversion, flux, export | Round-trip (load → export → load) reproduces values; A/B/C round-trips and anchor tests pass |
| 2. Viewer | Workspace, isocandela and false-colour plots, sections, cursor | A real file displays correctly against a reference viewer |
| 3. Arithmetic | Add, subtract, multiply, divide with provenance; difference view in the viewer | Synthetic cases match hand calculation; coverage/NaN rules hold |
| 4. Rotate / aim | 3D rotation and resampling ("aim to cut-off" moved to Phase 5) | Yaw equals exact H shift; rotate then inverse-rotate returns the original within tolerance; flux conserved |
| 5. Cut-off analysis | Gradient scan, cut-off line trace, "aim to cut-off" | Synthetic beam with a known cut-off position and gradient is recovered |
| 6. Regulation engine | JSON schema, engine, overlay, first two regulations migrated from PIRA and beamTolerance | Results match those tools on the same files |
| 7. Road performance | Shared road module, isolux view, requirements check | Matches Road-illuminate output on the same inputs |
| 8. Report and polish | Printable report, presets, error messages, docs | A full evaluation can be exported and understood by someone else |

## 10. Validation and tests

- **Synthetic fixtures** generated by script with analytic answers. In place since Phase 1: uniform source over the full sphere and over a limited range (known flux), Gaussian spot (known peak and position), asymmetric pattern (catches left/right and up/down flips), laterally symmetric half file, the same beam stored as Type A, B and C, format variants (1986–2019 headers, mixed separators, factors ≠ 1, TILT=INCLUDE and file reference) and malformed files. Still to add in Phase 5: step cut-off with a defined gradient.
- **Sign convention test**: an asymmetric fixture must display with the hot spot on the correct side. This is the most common bug class in IES tools.
- **Invariants**: `A + B − B = A`; `(A × k) / k = A`; rotation conserves flux within interpolation tolerance; export then import is lossless to the written precision.
- **Cross-tool checks**: same file, same settings, compared against PIRA, beamTolerance, Road-illuminate and beamCorrelate.
- **Real files** stay out of the repo. Keep them in `local-data/`, which is git-ignored.
- **core/ purity**: a test and a separate type-check of `core/` without DOM types fail if anything under `core/` imports from `ui/` or uses `document` / `window`.
- **Viewer data**: every synthetic fixture is loaded through the same store the UI uses, and its peak must be at the known position; the asymmetric fixture's hot spot must be right and up in the plotted matrix too.
- **Arithmetic**: hand-calculated cases for every operation; invariants A + B − B = A (1e-12 relative on identical grids, 1e-9 on different grids, compared on the merged grid), scale by k then 1/k = A (1e-12), divide(A, A) = 1 exactly above the floor, flux(A + B) = flux(A) + flux(B) on the same coverage; intersection, union and treat-as-zero; kind rules and IES export refusal; provenance content and chain.
- **Rotation**: sign of yaw, pitch and roll on direction vectors and on the asymmetric fixture; pure yaw = exact H shift; H = 0 pitched by p → V + p exactly; H = 90°, V = 0 unchanged by pitch; roll 90° maps (h, 0) to (0, −h); Gaussian peak at the hand-computed position (within half a grid step); two rotations = one composed rotation (1e-9 of peak); rotate then inverse, composed: exact (1e-9 of peak); without composition, smooth beam on a 3° grid: within 0.1% of peak (measured 0.047%); flux on the extended grid within 0.05% (measured 0.004%).
- **Cut-off**: sigmoid fixtures with an analytic answer (edge at V0 → cut-off at V0 − 0.05°, Gmax = A·tanh(0.05 / (2w))) on 0.05° and 0.25° grids, a kinked beam (elbow at H 1°, 15° shoulder) and its mirror, and a noisy beam with a second, weaker edge. Fine grid: position within 0.005° (measured 0.0001°), Gmax within 1% (measured 0.01%); kink: elbow within 0.02°, shoulder within 0.05° (measured exact); pitched by 0.33°: within 0.01° (measured 0.005°, resampling); aim: converges, residual ≤ 0.005°, correction within 0.01° of the geometric value.
- **Regulation engine**: a TEST file of invented values only; hand-computed results on a plane field I = 3000 + 100·H + 50·V (bilinear exact) for every element type and every limit form; unit conversion, mirroring, search radius, scale factor; not-evaluated cases (point outside coverage, zone and line partly outside, missing position, NaN); re-aim search recovers a known optimum on a mis-aimed spot within 0.05°; validator messages.
- **Regressions**: each value mismatch found against a reference gets a synthetic fixture and a test (e.g. `fine-cutoff-typeB.ies` for the Phase 2 resampling-step fix).
- **Browser check**: tests run in Node and do not run Plotly, so after UI changes also load files in the dev server and in the production build (`npm run build`, then `npm run preview`) and check the console for errors.

## 11. Decisions

1. **Stack.** *Settled:* TypeScript (strict), Vite, Vitest, static deploy to GitHub Pages via GitHub Actions. One runtime dependency: `plotly.js` **4.2.0** (pinned exactly), imported as a minimal bundle — `lib/core` (includes scatter) plus the heatmap trace only — about 400 KB gzipped. `vite.config.ts` drops Plotly's unused map-trace CSS and maps Node's `global` to `globalThis` for its dependencies. Any further dependency needs approval. If Road-illuminate is plain JavaScript, either match it or convert its calculation core as part of Phase 7.
2. **Shared code.** *Open.* Copy the road module into this repo, or publish a small shared `lighting-core` package that all your tools import. The second is more work now and much less later.
3. **Which regulations first.** *Open.* Suggested order: R149 Class C low beam, R149 high beam, R148 signal functions, FMVSS 108.
4. **Default interpolation.** *Bilinear for now* (the only method implemented). Bicubic looks smoother but can overshoot near a cut-off; decide before Phase 5.
5. **Licence and visibility.** *Settled:* © 2026 Jalib Akther, all rights reserved. The GitHub repository and the Pages site are public.
6. **Exporting datasets with missing data.** *Open.* IES export refuses `NaN`. Phase 3 added `clampToIntensity` (negatives → 0) and "treat as zero" per input, but no crop or fill of `NaN` regions. Decide whether to offer "crop to the largest fully covered rectangle", "fill with zero on explicit request", or both.
7. **Type B/C axis assumptions.** *Open until verified.* Check `AXIS_ASSUMPTIONS` (section 3.2) against a reference viewer with real Type B and C files from your sources, and record the result here. The Phase 2 viewer can now be used for this.
8. **Loading Plotly on demand.** *Open, low priority.* Plotly is ~95% of the bundle. Loading it only when the first file is opened (dynamic import) would make the empty page load faster.

## 12. Working with Claude Code

Standing rules for every phase:

- Read this file fully before starting, and do one phase at a time; stop at the end of the phase and report test results, typecheck and build output, and open questions.
- Write the fixtures and tests before the implementation of each function.
- Keep `core/` free of any DOM or plotting code; all files are processed locally in the browser.
- Ask before adding any dependency.
- Do not invent regulation limit values — leave them `null` in JSON until they are supplied.
- If LM-63 or a regulation is ambiguous, do not guess silently: pick the most common interpretation, add a warning code, and list it in the report.
- Do not commit or push until the changes have been reviewed.

Original kickoff prompt (kept for reference; Phases 0 and 1 were in the end run as separate steps):

> Read FRAMEWORK.md fully. We are building this tool phase by phase. Start with Phase 0 and Phase 1 only. Rules: keep `core/` free of any DOM or plotting code; all files are processed locally in the browser; write the synthetic fixture generator and tests before the implementation of each function; do not invent regulation limit values — leave them `null` in JSON until I supply them; follow the Type A H-V sign convention in section 3.1 and add the sign-convention test. Stop at the end of Phase 1 and show me the test results and any open questions before continuing.
