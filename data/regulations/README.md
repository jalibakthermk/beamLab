# data/regulations

One JSON file per regulation (or customer specification), validated by `core/regs/schema.ts`.

**Rule:** every numeric value (test points, zones, lines, limits, tolerances, aim ranges) must be transcribed from the official document and checked. Never from memory. Values that are not supplied stay `null`; elements with null values are reported as "not evaluated", never as a pass. New files start with `"verified": false`; the app shows an "unverified limits" banner until it is set to `true` after checking.

Shape (all values shown as null on purpose):

```json
{
  "id": "…", "title": "…", "source": "document, paragraph", "revision": "…",
  "verified": false,
  "units": "cd",                       // or "lx@25m" (converted with cd = lx × 625)
  "mirrorForLeftHandTraffic": false,   // file written for right-hand traffic
  "parameters": { "name": null },      // values that percentage limits can refer to
  "aim": { "modes": ["as-loaded"], "nominalCutoffV": null, "reaim": { "h": null, "v": null } },
  "elements": [
    { "type": "point", "name": "…", "h": null, "v": null, "min": null, "max": null, "searchRadius": null, "ref": "table / paragraph" },
    { "type": "line",  "name": "…", "from": [null, null], "to": [null, null], "min": null },
    { "type": "zone",  "name": "…", "polygon": [[null, null], [null, null], [null, null]], "max": null },
    { "type": "ratio", "name": "…", "a": "element name", "b": "element name", "min": null, "max": null },
    { "type": "global","name": "…", "max": null }
  ]
}
```

A limit is a number (file units), `null`, or a percentage of a reference: `{ "percent": null, "of": "max" }`, `{ "percent": null, "of": { "element": "name" } }` or `{ "percent": null, "of": { "parameter": "name" } }`.

The test suite uses its own file with invented values (`tests/fixtures/regs/TEST-invented-values.json`); it is never copied here.
