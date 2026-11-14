# beamLab — IES Workbench

A browser tool to open, evaluate and manipulate photometric IES (LM-63) files for automotive lamps: view intensity distributions, check them against regulations and road-illumination requirements, and combine, scale or re-aim them.

**Files are processed locally in your browser. Nothing is uploaded.** There is no backend and no analytics on file content.

See [FRAMEWORK.md](FRAMEWORK.md) for the design and build phases.

## Development

Requires Node.js 20.19 or newer.

```bash
npm install         # install dev tools
npm run dev         # local dev server with hot reload
npm run typecheck   # strict TypeScript check (core/ is also checked without DOM types)
npm test            # run Vitest once
npm run build       # production build into dist/
npm run preview     # serve the built dist/ locally
```

Put real IES files in `local-data/`. That folder is git-ignored and must never be committed. Test fixtures in `tests/fixtures/` are synthetic only.

## Project layout

- `core/` — pure TypeScript library (parsing, geometry, operations, analysis, regulations, road). No DOM code; enforced by `tests/core-purity.test.ts` and `tsconfig.core.json`.
- `ui/` — browser user interface; calls into `core/`.
- `data/` — regulation definitions and presets as JSON.
- `tests/` — Vitest tests and synthetic fixtures.

## Licence

© 2026 Jalib Akther. All rights reserved. See [LICENSE](LICENSE).
