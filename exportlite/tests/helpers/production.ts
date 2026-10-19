import { setTimeout } from "node:timers/promises";

/** ZIP workers and socket queues can keep filling after the first output write. */
export async function stalledProduction(read: () => number): Promise<number> {
  const deadline = performance.now() + 2_000;
  let previous = read();
  let changed = performance.now();
  while (performance.now() < deadline) {
    await setTimeout(10);
    const current = read();
    if (current !== previous) {
      previous = current;
      changed = performance.now();
    }
    // Observe an actual, sustained stall rather than assuming a warmup duration.
    if (current > 0 && performance.now() - changed >= 100) return current;
  }
  throw new Error("Production did not stall under downstream backpressure.");
}
