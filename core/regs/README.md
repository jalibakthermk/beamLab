# core/regs

Regulation check: file schema and hand-written validator (`schema.ts`), the generic engine (`engine.ts`: points, lines, zones, ratios, global maximum; limits absolute or as a percentage of an element, the maximum or a parameter; test conditions; mirroring; not-evaluated handling; CSV) and aim modes (`reaim.ts`: as loaded, aim to cut-off, re-aim search). Limits live in `data/regulations/*.json`, never in code. No DOM code.
