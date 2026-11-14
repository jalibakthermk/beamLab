# Adding a regulation

Regulation files live in `data/regulations/`, one JSON file per regulation or customer specification. They are validated by `core/regs/schema.ts` and checked by `core/regs/engine.ts`.

## The rule

**Every number comes from the official document.** That covers test points, zones, lines, limits, tolerances and aim ranges.

- Transcribe numbers from the text and check them.
- Never fill in a value from memory.
- A value that is not given stays `null`. An element with a `null` value is "not evaluated", never a pass.
- New files start with `"verified": false`. The app and the report then show an "unverified limits" notice next to every result, and it cannot be switched off.

## Schema

| Field | Meaning |
|---|---|
| `id` | Unique id; must equal the file name without `.json`. |
| `title`, `source`, `revision` | What the file is, the document and paragraph it comes from, and the revision or amendment. |
| `verified` | `false` until every value has been checked against the official text. |
| `units` | `"cd"`, or `"lx@25m"` (converted with cd = lx × 625). |
| `mirrorForLeftHandTraffic` | `true` only if the document says the values mirror for left-hand traffic. |
| `parameters` | Named values that percentage limits can refer to. |
| `aim.modes` | Allowed aim modes: `as-loaded`, `aim-to-cutoff`, `re-aim-search`. |
| `aim.nominalCutoffV` | Nominal cut-off position (degrees), needed for `aim-to-cutoff`. |
| `aim.reaim` | Permitted re-aim range, ± degrees in H and V. |
| `elements` | The test points, lines, zones, ratios and global limits (below). |

### Element types

| Type | Fields | Checked value |
|---|---|---|
| `point` | `h`, `v`, optional `searchRadius` | Intensity at (h, v); with a radius, the most favourable value within it. |
| `line` | `from: [h, v]`, `to: [h, v]` | Lowest (for `min`) or highest (for `max`) value along the line. |
| `zone` | `polygon: [[h, v], …]` | Lowest or highest value inside the polygon. |
| `ratio` | `a`, `b` (element names) | Value of `a` ÷ value of `b`. |
| `global` | — | Maximum over the whole dataset. |

Every element has a `name`, an optional `ref` (the table or paragraph), and `min` and/or `max`.

### Limits

A limit is one of:

- a number, in file units;
- `null`;
- a percentage of a reference:
  - `{ "percent": p, "of": "max" }`
  - `{ "percent": p, "of": { "element": "name" } }`
  - `{ "percent": p, "of": { "parameter": "name" } }`

## Annotated example (TEST values only)

This excerpt is from `tests/fixtures/regs/TEST-invented-values.json`. **Every value is invented** for the test suite; never copy it into `data/regulations/`.

```jsonc
{
  "id": "TEST-invented-values",            // = file name
  "title": "TEST ONLY: invented values, not a regulation.",
  "source": "beamLab test suite (all values invented)",
  "revision": "test",
  "verified": false,                       // shows the unverified-limits notice
  "units": "cd",
  "mirrorForLeftHandTraffic": true,        // only if the document says so
  "parameters": { "Iref": 4000 },          // used by "Q" below
  "aim": {
    "modes": ["as-loaded", "aim-to-cutoff", "re-aim-search"],
    "nominalCutoffV": null,                // not given → aim-to-cutoff is refused
    "reaim": { "h": null, "v": null }      // not given → no re-aim range
  },
  "elements": [
    { "type": "point", "name": "P", "h": 2.5, "v": -1.5, "min": 3000, "ref": "invented table 1" },
    { "type": "point", "name": "Q", "h": 0, "v": 0, "min": { "percent": 80, "of": { "parameter": "Iref" } } },
    { "type": "point", "name": "R1", "h": 0, "v": 0, "min": 3100, "searchRadius": 1 },
    { "type": "line", "name": "L", "from": [-4, 0], "to": [4, 2], "min": 2500 },
    { "type": "zone", "name": "Zmax", "polygon": [[-2, -2], [2, -2], [2, 2], [-2, 2]], "max": 3400 },
    { "type": "ratio", "name": "P/Q", "a": "P", "b": "Q", "min": 1.05, "max": 1.2 },
    { "type": "global", "name": "Imax", "max": 4100 },
    { "type": "point", "name": "NoLimit", "h": 1, "v": 1, "min": null }   // → not evaluated
  ]
}
```

## Steps

1. Copy the shape from `data/regulations/README.md`. Set `"verified": false` and leave every value `null`.
2. Fill in values from the official document. Add a `ref` to each element (table or paragraph). Write L as negative H, R as positive H, U as positive V and D as negative V.
3. Record anything you cannot encode in `notes` and in `data/regulations/MIGRATION.md`, for example sums of points or "and below" conditions. Do not approximate it.
4. Run `npm test`. `tests/regulations-data.test.ts` validates every file, checks that each `id` matches its file name, and runs the engine on a fixture.
5. Load a known lamp in the app (Evaluate tab) and compare the results with a reference tool, or with hand calculation at a few points.
6. **Verification step:** a second person checks every value against the official text, point by point. Only then set `"verified": true`, and note who checked it and when in the commit message.

A file can also be loaded in the app without adding it to the repository: Evaluate tab → "Load a regulation file". It is kept in memory for the session only.
