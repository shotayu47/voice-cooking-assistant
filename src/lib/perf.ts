/**
 * Development-only latency instrumentation.
 *
 * Prints nothing in production, and never prints user ids, emails, tokens or
 * row contents — only a label and a duration.
 *
 * Enable with PERF_LOG=1 (dev only):
 *   PERF_LOG=1 npm run dev
 */

const ENABLED = process.env.NODE_ENV !== 'production' && process.env.PERF_LOG === '1';

export async function timed<T>(label: string, run: () => Promise<T>): Promise<T> {
  if (!ENABLED) return run();

  const start = performance.now();
  try {
    return await run();
  } finally {
    const ms = performance.now() - start;
    console.log(`[perf] ${label.padEnd(28)} ${ms.toFixed(1)}ms`);
  }
}

export function mark(label: string, startedAt: number): void {
  if (!ENABLED) return;
  console.log(`[perf] ${label.padEnd(28)} ${(performance.now() - startedAt).toFixed(1)}ms`);
}

export function now(): number {
  return ENABLED ? performance.now() : 0;
}
