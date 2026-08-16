import { describe, expect, it } from 'vitest';

import {
  afterRateLimit,
  backoffFor,
  BACKOFF,
  canRetryAfterRateLimit,
  cooldownSecondsLeft,
  describeRateLimit,
  MAX_RATE_LIMIT_RETRIES,
  NO_RATE_LIMIT,
  RESET_SAFETY_MS,
  waitFromSnapshots,
} from './rate-limit';
import { INITIAL_TURN, reduceTurn, describeFailure, type VoiceEvent } from './turn-state';

/**
 * Five responses failed in a row with `rate_limit_exceeded`, and the gaps
 * between attempts got *shorter* — because nothing paced them. Refused
 * requests count against the allowance too, so retrying fast is the one
 * strategy guaranteed to keep it exhausted.
 */

const T = 5_000_000;
const steady = () => 0; // no jitter, so growth is assertable

describe('7 — a rate limit is its own failure', () => {
  const committed: VoiceEvent[] = [
    { type: 'speech_started', at: T },
    { type: 'speech_stopped', at: T + 400 },
    { type: 'committed', at: T + 500 },
  ];

  it('is not folded in with ordinary failures', () => {
    const state = [
      ...committed,
      { type: 'response_created' as const, at: T + 800, responseId: 'R6' },
      {
        type: 'response_done' as const,
        at: T + 900,
        responseId: 'R6',
        status: 'failed',
        errorCode: 'rate_limit_exceeded',
      },
    ].reduce(reduceTurn, INITIAL_TURN);

    expect(state.failure).toBe('rate_limited');
  });

  it('still reports a plain failure as a plain failure', () => {
    const state = [
      ...committed,
      { type: 'response_created' as const, at: T + 800, responseId: 'R6' },
      { type: 'response_done' as const, at: T + 900, responseId: 'R6', status: 'failed' },
    ].reduce(reduceTurn, INITIAL_TURN);

    expect(state.failure).toBe('failed');
  });

  it('says something specific, not "応答に失敗しました"', () => {
    const state = [
      ...committed,
      { type: 'response_created' as const, at: T + 800, responseId: 'R6' },
      {
        type: 'response_done' as const,
        at: T + 900,
        responseId: 'R6',
        status: 'failed',
        errorCode: 'rate_limit_exceeded',
      },
    ].reduce(reduceTurn, INITIAL_TURN);

    expect(describeFailure(state)).toContain('利用制限');
    expect(describeFailure(state)).not.toContain('応答に失敗しました');
  });

  it('describes the wait in the user-facing wording', () => {
    const state = afterRateLimit(NO_RATE_LIMIT, T, null, steady);

    expect(describeRateLimit(state, T)).toContain('利用制限');
    expect(describeRateLimit(state, T)).toMatch(/\d+秒/);
  });
});

describe('the server’s own numbers come first', () => {
  it('waits out the tokens window even though the allowance is not empty', () => {
    /*
     * The refusal that prompted this: remaining=4191, reset_seconds=54. The
     * allowance was not exhausted — it was too small for what the next
     * response needed. Requiring remaining<=0 threw those 54 seconds away and
     * retried after 2.4s, straight back into the wall.
     */
    expect(
      waitFromSnapshots([
        { name: 'requests', remaining: 90, reset_seconds: 2 },
        { name: 'tokens', remaining: 4191, reset_seconds: 54 },
      ]),
    ).toBe(54_000 + RESET_SAFETY_MS);
  });

  it('prefers the tokens window, since that is the one that runs short', () => {
    expect(
      waitFromSnapshots([
        { name: 'requests', remaining: 0, reset_seconds: 3 },
        { name: 'tokens', remaining: 0, reset_seconds: 20 },
      ]),
    ).toBe(20_000 + RESET_SAFETY_MS);
  });

  it('waits out the longest window when tokens is not reported', () => {
    expect(
      waitFromSnapshots([
        { name: 'requests', remaining: 0, reset_seconds: 3 },
        { name: 'other', remaining: 0, reset_seconds: 8 },
      ]),
    ).toBe(8_000 + RESET_SAFETY_MS);
  });

  it('lands past the reset rather than on it', () => {
    // Returning at the exact boundary risks another refusal, and a refused
    // request still counts against the allowance.
    expect(waitFromSnapshots([{ name: 'tokens', reset_seconds: 10 }])).toBeGreaterThan(10_000);
  });

  it('falls back when the event was never received', () => {
    expect(waitFromSnapshots(null)).toBeNull();
    expect(waitFromSnapshots([])).toBeNull();
  });

  it('falls back when no window was reported', () => {
    expect(waitFromSnapshots([{ name: 'tokens', remaining: 0 }])).toBeNull();
  });

  it('prefers the reported reset over the backoff', () => {
    const state = afterRateLimit(NO_RATE_LIMIT, T, [{ name: 'tokens', remaining: 4191, reset_seconds: 9 }], steady);

    expect(state.cooldownUntil).toBe(T + 9_000 + RESET_SAFETY_MS);
  });
});

describe('8-9 — cooldown and growing backoff', () => {
  it('refuses a retry while cooling down', () => {
    const state = afterRateLimit(NO_RATE_LIMIT, T, null, steady);

    expect(canRetryAfterRateLimit(state, T)).toBe('cooling_down');
    expect(canRetryAfterRateLimit(state, T + 100)).toBe('cooling_down');
  });

  it('allows it once the wait has passed', () => {
    const state = afterRateLimit(NO_RATE_LIMIT, T, null, steady);

    expect(canRetryAfterRateLimit(state, state.cooldownUntil)).toBe('allowed');
  });

  it('grows the wait with each refusal', () => {
    const first = backoffFor(0, steady);
    const second = backoffFor(1, steady);
    const third = backoffFor(2, steady);

    expect(second).toBeGreaterThan(first);
    expect(third).toBeGreaterThan(second);
  });

  it('caps the wait', () => {
    expect(backoffFor(99, steady)).toBeLessThanOrEqual(BACKOFF.maxMs * (1 + BACKOFF.jitter));
  });

  it('adds jitter, so clients do not all return together', () => {
    expect(backoffFor(0, () => 1)).toBeGreaterThan(backoffFor(0, () => 0));
  });

  it('never reports a negative countdown', () => {
    const state = afterRateLimit(NO_RATE_LIMIT, T, null, steady);

    expect(cooldownSecondsLeft(state, T + 999_999)).toBe(0);
  });
});

describe('10 — a ceiling on manual retries', () => {
  it('stops offering after the limit', () => {
    let state = NO_RATE_LIMIT;
    for (let i = 0; i < MAX_RATE_LIMIT_RETRIES; i += 1) {
      state = afterRateLimit(state, T, null, steady);
    }

    expect(state.attempts).toBe(MAX_RATE_LIMIT_RETRIES);
    expect(canRetryAfterRateLimit(state, T + 999_999)).toBe('exhausted');
  });

  it('points at the text fallback once exhausted', () => {
    let state = NO_RATE_LIMIT;
    for (let i = 0; i < MAX_RATE_LIMIT_RETRIES; i += 1) {
      state = afterRateLimit(state, T, null, steady);
    }

    expect(describeRateLimit(state, T)).toContain('テキストで続けて');
  });

  it('counts each refusal once', () => {
    const once = afterRateLimit(NO_RATE_LIMIT, T, null, steady);

    expect(once.attempts).toBe(1);
  });
});

describe('11-12 — what resets it, and what must not set it', () => {
  it('starts clean, so a new committed turn is unaffected', () => {
    // The hook resets to NO_RATE_LIMIT on `committed`; this pins the value it
    // resets to.
    expect(NO_RATE_LIMIT.attempts).toBe(0);
    expect(canRetryAfterRateLimit(NO_RATE_LIMIT, T)).toBe('allowed');
  });

  it('does not treat a barge-in as a rate limit', () => {
    const speaking = [
      { type: 'speech_started' as const, at: T },
      { type: 'speech_stopped' as const, at: T + 400 },
      { type: 'committed' as const, at: T + 500 },
      { type: 'response_created' as const, at: T + 800, responseId: 'R2' },
    ].reduce(reduceTurn, INITIAL_TURN);

    const bargedIn = reduceTurn(speaking, { type: 'speech_started', at: T + 2000 });
    const after = reduceTurn(bargedIn, {
      type: 'response_done',
      at: T + 2039,
      responseId: 'R2',
      status: 'cancelled',
      reason: 'turn_detected',
    });

    expect(after.failure).toBeNull();
    expect(after.phase).toBe('listening');
  });
});
