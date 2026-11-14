# core/geometry

Coordinate work via unit direction vectors: Type A/B/C angle conversions (Type B/C vehicle-axis mapping in `AXIS_ASSUMPTIONS`, `coords.ts`), bilinear interpolation, resampling (Type A → A, Type B/C → canonical Type A on load, and the common grid of binary operations), flux / solid-angle weights, and rotation / aim (`rotate.ts`: yaw, pitch, roll as a true rotation on the sphere). Planned: bicubic interpolation (decision pending). No DOM code.
