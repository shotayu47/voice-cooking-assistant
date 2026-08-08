import { describe, expect, it } from 'vitest';

import {
  appendLog,
  classifyLaunch,
  clockSkew,
  formatDuration,
  formatGap,
  remainingMs,
  type DiagLogEntry,
} from './timer-diag';

const entry = (id: number): DiagLogEntry => ({ id, at: id * 1000, kind: `event ${id}` });

describe('remainingMs', () => {
  it('derives the remainder from the deadline, not from elapsed ticks', () => {
    expect(remainingMs(10_000, 4_000)).toBe(6_000);
  });

  it('clamps to zero once the deadline has passed', () => {
    // The page can come back from the background long after the deadline; a
    // negative remainder would render as a counting-up timer.
    expect(remainingMs(10_000, 999_000)).toBe(0);
  });

  it('reports no remainder when no timer is running', () => {
    expect(remainingMs(null, 4_000)).toBeNull();
  });
});

describe('appendLog', () => {
  it('puts the newest entry first', () => {
    const log = appendLog([entry(1)], entry(2));
    expect(log.map((e) => e.id)).toEqual([2, 1]);
  });

  it('drops the oldest entries past the limit', () => {
    const log = [entry(3), entry(2), entry(1)];
    expect(appendLog(log, entry(4), 3).map((e) => e.id)).toEqual([4, 3, 2]);
  });

  it('does not mutate the log it was given', () => {
    const log = [entry(1)];
    appendLog(log, entry(2));
    expect(log).toHaveLength(1);
  });
});

describe('classifyLaunch', () => {
  it('treats a surviving session record as a reload', () => {
    expect(classifyLaunch(true, 3)).toBe('same-session-reload');
  });

  it('treats a lost session with a persisted launch count as a discarded session', () => {
    expect(classifyLaunch(false, 3)).toBe('session-lost');
  });

  it('treats nothing at all as the first run', () => {
    expect(classifyLaunch(false, 0)).toBe('first-run');
  });

  it('prefers the session record even on the very first launch count', () => {
    expect(classifyLaunch(true, 0)).toBe('same-session-reload');
  });
});

describe('formatDuration', () => {
  it('formats under an hour as m:ss', () => {
    expect(formatDuration(305_000)).toBe('5:05');
  });

  it('formats an hour or more as h:mm:ss', () => {
    expect(formatDuration(3_725_000)).toBe('1:02:05');
  });

  it('clamps negatives to zero', () => {
    expect(formatDuration(-5_000)).toBe('0:00');
  });
});

describe('formatGap', () => {
  it('shows short gaps in milliseconds', () => {
    expect(formatGap(1_004)).toBe('1004ms');
  });

  it('adds a readable duration once the gap is long', () => {
    expect(formatGap(185_000)).toBe('3:05 (185000ms)');
  });

  it('renders a missing gap as a dash', () => {
    expect(formatGap(null)).toBe('—');
  });
});

describe('clockSkew', () => {
  it('is zero when both clocks advanced together', () => {
    expect(clockSkew(1_000, 1_000)).toBe(0);
  });

  it('is positive when the wall clock ran on while performance.now stalled', () => {
    // This is the signature of a suspended page: real time passed, the
    // monotonic clock did not.
    expect(clockSkew(180_000, 1_200)).toBe(178_800);
  });
});
