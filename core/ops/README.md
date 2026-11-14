# core/ops

Non-destructive dataset operations (`arithmetic.ts`): add, subtract, scale, multiply, divide, clamp a difference to intensity, and window masks. Binary operations follow align → common grid → operate → tag provenance and return a new dataset; inputs are never modified. Planned: rotate/aim (Phase 4). No DOM code.
