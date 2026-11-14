# core/ops

Non-destructive dataset operations (`arithmetic.ts`): add, subtract, scale, multiply, divide, clamp a difference to intensity, and window masks. Binary operations follow align → common grid → operate → tag provenance and return a new dataset; inputs are never modified. Aim to cut-off is in `aim.ts`. No DOM code.
