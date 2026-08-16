/**
 * Pacing retries after the Realtime API refuses on rate.
 *
 * Five responses failed in a row with `rate_limit_exceeded`, and the trace
 * shows the gaps between attempts *shrinking* — because there is no pacing at
 * all, so the interval was however fast the user could tap. Failed requests
 * count against the allowance too, which makes an impatient retry loop the one
 * thing guaranteed to keep it exhausted.
 *
 * Nothing here retries by itself. It decides how long the button stays
 * disabled and when to stop offering it; pressing it remains the user's.
 */

/** One entry of `rate_limits.updated`. */
export type RateLimitSnapshot = {
  name?: 'requests' | 'tokens' | string;
  limit?: number;
  remaining?: number;
  reset_seconds?: number;
};

/** Manual retries allowed per committed turn. */
export const MAX_RATE_LIMIT_RETRIES = 3;

/** Added to a reported reset, so the retry lands after the window, not on it. */
export const RESET_SAFETY_MS = 1_000;

/** Bounds on the fallback wait, used only when the server tells us nothing. */
export const BACKOFF = {
  baseMs: 2_000,
  maxMs: 30_000,
  /** Up to this fraction of the delay, added at random. */
  jitter: 0.25,
} as const;

/**
 * Which limit does this error refer to?
 *
 * `rate_limit_exceeded` carries no name of its own, so the reported limits are
 * matched by what has actually run out. Ambiguity resolves to the longest wait
 * among the exhausted limits — waiting too long is recoverable, waiting too
 * little spends another request on a refusal.
 */
export function waitFromSnapshots(
  limits: readonly RateLimitSnapshot[] | null | undefined,
): number | null {
  if (!limits || limits.length === 0) return null;

  /*
   * `remaining` is not the test.
   *
   * The refusal that prompted this arrived with remaining=4191 and
   * reset_seconds=54 — the allowance was not empty, it was merely too small
   * for what the next response needed. Waiting only for limits at zero meant
   * the server's own 54 seconds were discarded and a 2.4s backoff used
   * instead, which is a retry into a wall.
   *
   * `remaining` also reflects the reservation a response makes when it is
   * created, not just tokens already spent, so it cannot be compared against
   * measured usage to decide what is left.
   */
  const reported = limits.filter((l) => typeof l.reset_seconds === 'number');
  if (reported.length === 0) return null;

  // The refusal names no limit. Tokens is the one that has run short every
  // time it has been observed, so it wins when present; otherwise wait out
  // the longest reported window.
  const tokens = reported.filter((l) => l.name === 'tokens');
  const pool = tokens.length > 0 ? tokens : reported;

  const seconds = Math.max(...pool.map((l) => l.reset_seconds as number));
  if (!Number.isFinite(seconds) || seconds < 0) return null;

  // A little past the reset: coming back at the exact boundary risks being
  // refused again and spending another request to learn it.
  return Math.round(seconds * 1000) + RESET_SAFETY_MS;
}

/**
 * The fallback: exponential, capped, with jitter so several clients coming
 * back from the same outage do not return in lockstep.
 *
 * `random` is injectable because a test asserting "the delay grows" should not
 * depend on chance.
 */
export function backoffFor(attempt: number, random: () => number = Math.random): number {
  const exponential = Math.min(BACKOFF.baseMs * 2 ** Math.max(0, attempt), BACKOFF.maxMs);
  return Math.round(exponential * (1 + random() * BACKOFF.jitter));
}

export type RateLimitState = {
  /** Manual retries already spent on this turn. */
  attempts: number;
  /** Epoch ms before which retrying is refused. */
  cooldownUntil: number;
};

export const NO_RATE_LIMIT: RateLimitState = { attempts: 0, cooldownUntil: 0 };

/**
 * Records a refusal and works out how long to wait.
 *
 * Server-reported reset time wins when there is one; otherwise the backoff
 * grows with the number of attempts already made.
 */
export function afterRateLimit(
  state: RateLimitState,
  now: number,
  limits: readonly RateLimitSnapshot[] | null | undefined,
  random: () => number = Math.random,
): RateLimitState {
  const reported = waitFromSnapshots(limits);
  const wait = reported ?? backoffFor(state.attempts, random);
  return { attempts: state.attempts + 1, cooldownUntil: now + wait };
}

/** Whole seconds left, for the button label. Never negative. */
export function cooldownSecondsLeft(state: RateLimitState, now: number): number {
  return Math.max(0, Math.ceil((state.cooldownUntil - now) / 1000));
}

export type RateLimitRetry =
  | 'allowed'
  /** Still inside the wait. */
  | 'cooling_down'
  /** Out of attempts for this turn. */
  | 'exhausted';

export function canRetryAfterRateLimit(state: RateLimitState, now: number): RateLimitRetry {
  if (state.attempts >= MAX_RATE_LIMIT_RETRIES) return 'exhausted';
  return now < state.cooldownUntil ? 'cooling_down' : 'allowed';
}

/** What the user is told. Never the same wording as an ordinary failure. */
export function describeRateLimit(state: RateLimitState, now: number): string {
  if (state.attempts >= MAX_RATE_LIMIT_RETRIES) {
    return '利用制限が続いています。音声を終了して、テキストで続けてください。';
  }

  const seconds = cooldownSecondsLeft(state, now);
  return seconds > 0
    ? `利用制限のため、${seconds}秒ほど待ってから再試行できます。`
    : '利用制限のため、少し待ってから再試行できます。';
}
