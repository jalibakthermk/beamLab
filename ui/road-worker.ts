/// <reference lib="webworker" />
// Runs the road calculation (core/road/results.ts) off the main thread.
import { runRoad, type RoadRunInput } from '../core/road/results';

self.onmessage = (ev: MessageEvent<{ id: number; input: RoadRunInput }>) => {
  const { id, input } = ev.data;
  try {
    const result = runRoad(input, () => performance.now());
    (self as unknown as Worker).postMessage({ id, result }, [result.field.values.buffer]);
  } catch (e) {
    (self as unknown as Worker).postMessage({ id, error: e instanceof Error ? e.message : String(e) });
  }
};
