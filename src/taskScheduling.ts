import * as os from "os";

/** Auto worker count: min(logical CPUs − 1, 4), at least 1. */
export function defaultWorkerCount(configured: number): number {
  if (configured > 0) return configured;
  return Math.max(1, Math.min(os.cpus().length - 1, 4));
}

/**
 * Run `fn` over `items` with at most `concurrency` in-flight promises.
 * Unlike unbounded `Promise.all(items.map(fn))`, this caps host/worker pressure.
 */
export async function scheduleBatched<T>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  const limit = Math.max(1, concurrency);
  let next = 0;
  const runners = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) break;
        await fn(items[i], i);
      }
    },
  );
  await Promise.all(runners);
}
