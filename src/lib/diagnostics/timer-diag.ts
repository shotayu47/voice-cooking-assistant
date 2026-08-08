/**
 * Pure helpers for the iOS timer diagnostics page (`/diagnostics/timer`).
 *
 * This module exists to measure what iOS Safari actually does to a running
 * page — it is not part of PHASE 6 and nothing here is used by the production
 * cooking timer. Keep it free of I/O so the arithmetic can be tested directly.
 */

/** Nominal interval period. The whole point is to see what we really get. */
export const TICK_MS = 1000;

/** A tick this late is worth a log line on its own. */
export const GAP_LOG_THRESHOLD_MS = 3000;

/** Newest-first log cap, so a phone left overnight cannot grow it forever. */
export const LOG_LIMIT = 200;

export const SESSION_KEY = 'tsugu-diag:timer-session';
export const LAUNCH_KEY = 'tsugu-diag:timer-launches';

export type DiagLogEntry = {
  id: number;
  /** `Date.now()` when the entry was recorded. */
  at: number;
  kind: string;
  detail?: string;
};

export function appendLog(
  log: readonly DiagLogEntry[],
  entry: DiagLogEntry,
  limit = LOG_LIMIT,
): DiagLogEntry[] {
  return [entry, ...log].slice(0, limit);
}

/**
 * The remaining time is always derived from the deadline, never from how many
 * times the interval fired. A throttled or suspended page fires far fewer
 * times than it should; counting ticks would silently under-report elapsed
 * time, which is exactly the failure mode PHASE 6 has to avoid.
 */
export function remainingMs(deadline: number | null, now: number): number | null {
  if (deadline === null) return null;
  return Math.max(0, deadline - now);
}

export type LaunchKind = 'first-run' | 'same-session-reload' | 'session-lost';

/**
 * Distinguishes "the document was re-created but the tab session survived"
 * from "the session storage itself is gone".
 *
 * `sessionStorage` survives a reload and an OS-driven page restore within the
 * same tab, but not a tab or process teardown. So a persisted launch count
 * with no session record is the signal that iOS discarded more than the
 * document.
 */
export function classifyLaunch(
  hasSessionRecord: boolean,
  previousLaunches: number,
): LaunchKind {
  if (hasSessionRecord) return 'same-session-reload';
  if (previousLaunches > 0) return 'session-lost';
  return 'first-run';
}

export const LAUNCH_LABEL: Record<LaunchKind, string> = {
  'first-run': '初回（この端末で初めて開いた）',
  'same-session-reload': '再読み込み — タブのセッションは生存',
  'session-lost': '新しいセッション — sessionStorage が失われた（タブ/プロセス破棄の疑い）',
};

/** `h:mm:ss` past an hour, `m:ss` below it. Negative input clamps to zero. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${minutes}:${ss}`;
}

/** Milliseconds, but readable at a glance on a phone. */
export function formatGap(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 10_000) return `${Math.round(ms)}ms`;
  return `${formatDuration(ms)} (${Math.round(ms)}ms)`;
}

/**
 * How far the two clocks disagree over the same span.
 *
 * `Date.now()` is wall clock and keeps moving while the page is suspended.
 * `performance.now()` is monotonic from page start and may or may not be
 * frozen with the page — which one it is, is a thing we need to measure
 * rather than assume.
 */
export function clockSkew(wallDelta: number, perfDelta: number): number {
  return wallDelta - perfDelta;
}
