# Changelog

All notable changes to beamLab. Versions follow semantic versioning.

## 1.0.0 — 2026-11-14

First release: Phase 8 (report and polish) on top of Phases 0–7.

### Added
- **Report:** a printable page (A4, print to PDF from the browser). You choose the sections:
  - header with title, author and notes;
  - file identity with SHA-256;
  - provenance;
  - regulation check with an isocandela plot and the elements drawn on it;
  - cut-off analysis with scan and trace plots;
  - road performance with the isolux plot, results and requirements;
  - conventions.

  The "unverified limits" notice appears next to the results of any unverified file and cannot be switched off. A summary of every "not evaluated" item is at the top, and the footer on every page reads "Engineering assessment generated locally. Not a type-approval document." The report data is built in `core/report/` and tested as an object.
- **Settings file:** export and import of every setting as JSON (view, evaluation, cut-off, road, report options, selection). It holds file names and SHA-256 hashes only, never file content. On import, files are matched by hash, and a notice lists the files to load again.
- **SHA-256 of every loaded file,** computed locally with Web Crypto.
- **Message table** (`core/messages.ts`): every warning and error code, with plain-language text and a suggested action. Unexpected errors show a generic message and never their raw text.
- **Interface:**
  - an in-app Help panel;
  - a busy indicator for loading, evaluation, re-aim search, operations, aim to cut-off and report building;
  - one empty state, "Load an IES file to begin", across the panels.
- **Documentation:** `docs/conventions.md`, `docs/adding-a-regulation.md`, this changelog, and a rewritten README.
- **End-to-end test** on synthetic fixtures: load, aim to cut-off, TEST regulation, cut-off analysis, road calculation, report object.

### Changed
- All number formatting now lives in one module (`core/format.ts`): cd, lx, degrees, percent, metres, lm, significant figures.
- Status is shown with an icon and text (✓ pass, ✗ fail, – not evaluated, ◐ incomplete), never by colour alone.
- Accessibility and layout: visible keyboard focus on every control; labels on all inputs; forms shrink at laptop widths (no horizontal scrolling at 1280 px).

### Removed
- Unused imports and one unused function in the road module.

## 0.x — development phases (2026-11-14)

- **Phase 7:** road performance check. Road illuminance ported from Road-illuminate, with a golden comparison against it; lanes and lamp pair; reach, width and points; requirements check; Road tab with the calculation in a Web Worker.
- **Regulation data:** 29 files from UN R148 Rev.0 Amend.5 and UN R149 Rev.0 Amend.6, all `verified: false`.
- **Phase 6:** regulation check engine (point, line, zone, ratio and global elements; percentage limits; aim modes including a re-aim search) and the Evaluate tab.
- **Phase 5:** cut-off analysis (gradient scan, line trace, two-segment fit) and aim to cut-off.
- **Phase 4:** rotate / aim as a true rotation on the sphere, with rotations composed.
- **Phase 3:** arithmetic with provenance (add, subtract, scale, multiply, divide, window) and a difference view.
- **Phase 2:** workspace and viewer (isocandela and false-colour views, sections, read-out, overlay), conversion and contour fixes.
- **Phase 1:** IES LM-63 parser (1986–2019), canonical Type A model, Type B and C conversion, flux, IES and CSV export.
- **Phase 0:** project setup, CI and GitHub Pages deploy.
