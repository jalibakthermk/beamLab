# beamLab — IES Workbench

A browser tool for photometric IES (LM-63) files of automotive lamps. It lets you:
- view intensity distributions;
- check them against regulations and road-illumination requirements;
- analyse the cut-off;
- combine, scale or re-aim distributions;
- print a report of the results.

**Files are processed locally in your browser. Nothing is uploaded.** There is no backend and no analytics. Files are held in memory only; nothing is written to browser storage. Settings files store file names and SHA-256 hashes, never file content.

> beamLab produces engineering assessments. It is not a type-approval tool. The bundled regulation files are marked `verified: false` until their values have been checked against the official text.

Version 1.0.0. See [CHANGELOG.md](CHANGELOG.md).

## Walkthrough

1. **Open files.** Drop `.ies` files anywhere on the page, or use **Open IES files…**.
   - LM-63-1986 to 2019 files are read, and Types A, B and C are supported. Everything is converted to Type A H-V (H right, V up).
   - The workspace on the left lists each file with its peak, grid step and warnings. Click a file to show it; tick **Overlay** to compare two.
2. **Viewer** (centre).
   - Shows isocandela contours or false colour, on a linear or log scale.
   - The cursor read-out shows the value at the pointer; click to set H and V cross-sections.
   - You can also export the view as a PNG.
3. **Info tab.**
   - Shows the summary: format, type, range, step, peak and flux.
   - Lists warnings, each with a suggested action, plus keywords and provenance.
   - Lets you mirror the file (flip H), export it as IES or CSV, and probe a value at an exact H and V.
4. **Evaluate tab.**
   - Choose a regulation file, the traffic side and an aim mode: as loaded, aim to cut-off first, or re-aim search.
   - The results table shows the measured value, limit, margin and status (✓ pass, ✗ fail, – not evaluated); elements are drawn in the viewer.
   - Unverified files carry a notice. You can export the results as CSV.
5. **Road tab.**
   - Lamps: dataset, position and aim, or the lamp pair helper. There are no hidden defaults; an EXAMPLE preset is provided.
   - Also enter the lanes, the grid and the isolux levels.
   - The viewer shows the road from above: illuminance on a log scale, isolux lines and lane markings.
   - Results: reach on the lane centre and edges, widths, point values and a requirements check. You can export them as CSV.
6. **Manipulate tab.**
   - Operations: add, subtract, scale, multiply, divide, window and rotate (yaw, pitch, roll).
   - Preview the result, then create a dataset with its provenance.
7. **Cut-off tab.**
   - Vertical gradient scan, cut-off line trace with a two-segment fit (elbow, shoulder), and sharpness against a preset.
   - Aim to the cut-off: a target in percent or degrees, optionally moving the elbow to H = 0.
8. **Report** (header).
   - Choose the sections: header, file identity with SHA-256, provenance, regulation check, cut-off, road, conventions.
   - Add a title, author and notes, then **Print / save as PDF** (A4).
9. **Settings** (header). **Export settings** saves every setting as JSON. **Import settings…** restores them and lists the files to load again; loaded files are matched by SHA-256.
10. **Help** (header): a short guide and links to the documentation.

Documentation:
- [docs/conventions.md](docs/conventions.md): axes, signs, Type B and C assumptions, interpolation, common grid, missing data.
- [docs/adding-a-regulation.md](docs/adding-a-regulation.md): the regulation file schema and the verification step.
- [FRAMEWORK.md](FRAMEWORK.md): design and build history.

## Development

Requires Node.js 20.19 or newer.

```bash
npm install         # install dev tools
npm run dev         # local dev server with hot reload
npm run typecheck   # strict TypeScript check (core/ is also checked without DOM types)
npm test            # run Vitest once
npm run build       # production build into dist/
npm run preview     # serve the built dist/ locally
npm run fixtures    # regenerate tests/fixtures/*.ies from tests/fixtures/generate.ts
npm run diagnose -- local-data/lamp.ies 0,0 5,-0.8 peak   # trace values through every parsing stage
```

Put real IES files in `local-data/`. That folder is git-ignored and must never be committed. Test fixtures in `tests/fixtures/` are synthetic only. `import/` (regulation source documents and other tools' sources) is git-ignored too.

## Project layout

- `core/` — pure TypeScript library: parsing, geometry, operations, analysis, regulations, road, report data, settings, messages and number formatting. No DOM code; this is enforced by `tests/core-purity.test.ts` and `tsconfig.core.json`.
- `ui/` — browser interface (plain TypeScript, no framework). It calls `core/` for every number; plots use a minimal Plotly bundle.
- `data/` — regulation files, road requirement template, and presets.
- `docs/` — conventions and how to add a regulation.
- `tests/` — Vitest tests, including an end-to-end test; `tests/fixtures/` holds synthetic IES files written by `generate.ts`.
- `scripts/` — fixture writer, value-tracing diagnostic, and the Road-illuminate golden-reference generator.

## Licence

© 2026 Jalib Akther. All rights reserved. See [LICENSE](LICENSE).
