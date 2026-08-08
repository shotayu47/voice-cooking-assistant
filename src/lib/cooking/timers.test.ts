import { describe, expect, it } from 'vitest';

import {
  addTimer,
  canAddTimer,
  completeTimer,
  createTimer,
  defaultTimerName,
  formatRemaining,
  isOverdue,
  MAX_TIMERS,
  obsoleteTimerKeys,
  OVERDUE_KEEP_MS,
  overdueMs,
  PAYLOAD_MAX_AGE_MS,
  parseTimers,
  remainingMs,
  removeTimer,
  saveTimers,
  serializeTimers,
  sortTimers,
  storageKey,
  TIMERS_SCHEMA_VERSION,
  type CookingTimer,
  type TimerStorage,
} from './timers';

const T0 = 1_800_000_000_000;
const MINUTE = 60_000;

function timer(overrides: Partial<CookingTimer> = {}): CookingTimer {
  return {
    id: 'a',
    name: '煮込み',
    deadline: T0 + 5 * MINUTE,
    createdAt: T0,
    origin: null,
    status: 'running',
    ...overrides,
  };
}

/** A `Storage` stand-in — the real one needs a browser. */
function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  const storage: TimerStorage & { map: Map<string, string> } = {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  };
  return storage;
}

/** Throws on every call, like Safari Private Browsing once the quota is hit. */
function hostileStorage(): TimerStorage {
  return {
    getItem: () => {
      throw new Error('denied');
    },
    setItem: () => {
      throw new Error('denied');
    },
    removeItem: () => {
      throw new Error('denied');
    },
  };
}

/** What the provider's store does on read: fetch the raw string, then parse. */
function readBack(storage: TimerStorage, key: string, now: number): CookingTimer[] {
  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch {
    raw = null;
  }
  return parseTimers(raw, now);
}

describe('deadline arithmetic', () => {
  it('derives the remaining time from the deadline and the wall clock', () => {
    const t = timer();
    expect(remainingMs(t, T0)).toBe(5 * MINUTE);
    expect(remainingMs(t, T0 + 2 * MINUTE)).toBe(3 * MINUTE);
  });

  it('never counts below zero once the deadline passes', () => {
    const t = timer();
    expect(remainingMs(t, T0 + 9 * MINUTE)).toBe(0);
    expect(overdueMs(t, T0 + 9 * MINUTE)).toBe(4 * MINUTE);
    expect(overdueMs(t, T0)).toBe(0);
  });

  it('is unaffected by how much time the page spent suspended', () => {
    // The measurement's Test D: 31m41s in the background, 2 ticks fired. A
    // tick-driven timer would be 31 minutes wrong here; a deadline is not.
    const t = createTimer({ id: 'a', name: '煮込み', durationMs: 10 * MINUTE, now: T0 });
    const resumedAt = T0 + 31 * MINUTE + 41_000;
    expect(remainingMs(t, resumedAt)).toBe(0);
    expect(isOverdue(t, resumedAt)).toBe(true);
  });

  it('starts a timer at the full duration and refuses a negative one', () => {
    expect(createTimer({ id: 'a', name: 'x', durationMs: 5 * MINUTE, now: T0 }).deadline).toBe(
      T0 + 5 * MINUTE,
    );
    expect(createTimer({ id: 'a', name: 'x', durationMs: -1, now: T0 }).deadline).toBe(T0);
  });
});

describe('overdue', () => {
  it('flags a running timer exactly at its deadline', () => {
    const t = timer();
    expect(isOverdue(t, T0 + 5 * MINUTE - 1)).toBe(false);
    expect(isOverdue(t, T0 + 5 * MINUTE)).toBe(true);
  });

  it('does not flag an acknowledged timer however long ago it ran out', () => {
    const t = timer({ status: 'done' });
    expect(isOverdue(t, T0 + 99 * MINUTE)).toBe(false);
  });
});

describe('formatRemaining', () => {
  it('rounds up so a fresh timer shows its full duration', () => {
    expect(formatRemaining(5 * MINUTE)).toBe('5:00');
    expect(formatRemaining(5 * MINUTE - 1)).toBe('5:00');
    expect(formatRemaining(59_001)).toBe('1:00');
  });

  it('reaches zero only at the deadline', () => {
    expect(formatRemaining(1)).toBe('0:01');
    expect(formatRemaining(0)).toBe('0:00');
    expect(formatRemaining(-5000)).toBe('0:00');
  });

  it('grows an hours field when needed', () => {
    expect(formatRemaining(90 * MINUTE)).toBe('1:30:00');
    expect(formatRemaining(3_600_000 + 5_000)).toBe('1:00:05');
  });
});

describe('adding and removing', () => {
  it('adds and removes without mutating the input', () => {
    const list: CookingTimer[] = [timer({ id: 'a' })];
    const added = addTimer(list, timer({ id: 'b' }));
    expect(added.map((t) => t.id)).toEqual(['a', 'b']);
    expect(list).toHaveLength(1);

    const removed = removeTimer(added, 'a');
    expect(removed.map((t) => t.id)).toEqual(['b']);
    expect(added).toHaveLength(2);
  });

  it('runs several timers at once, each on its own deadline', () => {
    let list: CookingTimer[] = [];
    list = addTimer(list, createTimer({ id: 'a', name: '麺', durationMs: 3 * MINUTE, now: T0 }));
    list = addTimer(list, createTimer({ id: 'b', name: '煮込み', durationMs: 20 * MINUTE, now: T0 }));

    const at = T0 + 5 * MINUTE;
    expect(isOverdue(list[0], at)).toBe(true);
    expect(remainingMs(list[1], at)).toBe(15 * MINUTE);
  });

  it('caps the list and reports when it is full', () => {
    let list: CookingTimer[] = [];
    for (let i = 0; i < MAX_TIMERS; i += 1) {
      list = addTimer(list, timer({ id: `t${i}` }));
    }
    expect(canAddTimer(list)).toBe(false);
    expect(addTimer(list, timer({ id: 'overflow' }))).toHaveLength(MAX_TIMERS);

    // Acknowledging one frees a slot: the cap is about live timers.
    expect(canAddTimer(completeTimer(list, 't0'))).toBe(true);
  });

  it('marks a timer done without disturbing the others', () => {
    const list = [timer({ id: 'a' }), timer({ id: 'b' })];
    const done = completeTimer(list, 'a');
    expect(done[0].status).toBe('done');
    expect(done[1].status).toBe('running');
  });
});

describe('defaultTimerName', () => {
  it('uses the step it was started from', () => {
    expect(defaultTimerName([], { stepIndex: 2, label: '工程3' })).toBe('工程3');
  });

  it('falls back to a number that is not already on screen', () => {
    expect(defaultTimerName([], null)).toBe('タイマー1');
    expect(defaultTimerName([timer({ name: 'タイマー1' })], null)).toBe('タイマー2');
    // Two existing timers already hold the next number, so skip past it.
    expect(
      defaultTimerName([timer({ id: 'a', name: 'x' }), timer({ id: 'b', name: 'タイマー3' })], null),
    ).toBe('タイマー4');
  });
});

describe('sortTimers', () => {
  it('puts the soonest deadline first and sinks acknowledged timers', () => {
    const list = [
      timer({ id: 'late', deadline: T0 + 20 * MINUTE }),
      timer({ id: 'done', deadline: T0 - 5 * MINUTE, status: 'done' }),
      timer({ id: 'overdue', deadline: T0 - MINUTE }),
      timer({ id: 'soon', deadline: T0 + MINUTE }),
    ];
    expect(sortTimers(list).map((t) => t.id)).toEqual(['overdue', 'soon', 'late', 'done']);
  });
});

describe('storage keys', () => {
  it('separates users, sessions and schema versions', () => {
    expect(storageKey('user-1', 'sess-1')).toBe(
      `tsugu:timers:v${TIMERS_SCHEMA_VERSION}:user-1:sess-1`,
    );
    expect(storageKey('user-1', 'sess-1')).not.toBe(storageKey('user-2', 'sess-1'));
    expect(storageKey('user-1', 'sess-1')).not.toBe(storageKey('user-1', 'sess-2'));
    expect(storageKey(null, 'sess-1')).toContain(':anon:');
  });

  it('identifies only foreign-version keys as obsolete', () => {
    const keys = [
      `tsugu:timers:v${TIMERS_SCHEMA_VERSION}:user-1:sess-1`,
      'tsugu:timers:v0:user-1:sess-1',
      'tsugu:timers:v999:user-1:sess-2',
      'tsugu-diag:timer-launches',
      'unrelated',
    ];
    expect(obsoleteTimerKeys(keys)).toEqual([
      'tsugu:timers:v0:user-1:sess-1',
      'tsugu:timers:v999:user-1:sess-2',
    ]);
  });
});

describe('serialize and restore', () => {
  it('round-trips a running timer', () => {
    const list = [timer({ id: 'a', origin: { stepIndex: 1, label: '工程2' } })];
    expect(parseTimers(serializeTimers(list, T0), T0)).toEqual(list);
  });

  it('drops acknowledged timers on the way out', () => {
    const list = [timer({ id: 'a' }), timer({ id: 'b', status: 'done' })];
    expect(parseTimers(serializeTimers(list, T0), T0).map((t) => t.id)).toEqual(['a']);
  });

  it('restores after the document was recreated, recomputing from the deadline', () => {
    const started = createTimer({ id: 'a', name: '煮込み', durationMs: 10 * MINUTE, now: T0 });
    const raw = serializeTimers([started], T0);

    // A new process, 7 minutes later: nothing ran in between.
    const restoredAt = T0 + 7 * MINUTE;
    const [restored] = parseTimers(raw, restoredAt);
    expect(remainingMs(restored, restoredAt)).toBe(3 * MINUTE);
    expect(isOverdue(restored, restoredAt)).toBe(false);
    expect(isOverdue(restored, T0 + 11 * MINUTE)).toBe(true);
  });
});

describe('restoring untrusted data', () => {
  it('ignores corrupt JSON rather than throwing', () => {
    expect(parseTimers('{not json', T0)).toEqual([]);
    expect(parseTimers('null', T0)).toEqual([]);
    expect(parseTimers('[]', T0)).toEqual([]);
    expect(parseTimers('', T0)).toEqual([]);
    expect(parseTimers(null, T0)).toEqual([]);
    expect(parseTimers(undefined, T0)).toEqual([]);
  });

  it('ignores a payload written by another schema version', () => {
    const older = JSON.stringify({ version: 0, savedAt: T0, timers: [timer()] });
    const newer = JSON.stringify({
      version: TIMERS_SCHEMA_VERSION + 1,
      savedAt: T0,
      timers: [timer()],
    });
    expect(parseTimers(older, T0)).toEqual([]);
    expect(parseTimers(newer, T0)).toEqual([]);
    expect(parseTimers(JSON.stringify({ savedAt: T0, timers: [timer()] }), T0)).toEqual([]);
  });

  it('ignores a payload older than a day', () => {
    // Deadline held at the boundary so this exercises the payload's age and
    // not the separate long-expired-timer rule.
    const raw = serializeTimers([timer({ deadline: T0 + PAYLOAD_MAX_AGE_MS })], T0);
    expect(parseTimers(raw, T0 + PAYLOAD_MAX_AGE_MS)).toHaveLength(1);
    expect(parseTimers(raw, T0 + PAYLOAD_MAX_AGE_MS + 1)).toEqual([]);
  });

  it('drops individual malformed records but keeps the sound ones', () => {
    const raw = JSON.stringify({
      version: TIMERS_SCHEMA_VERSION,
      savedAt: T0,
      timers: [
        timer({ id: 'ok' }),
        null,
        'nonsense',
        { ...timer({ id: 'no-deadline' }), deadline: 'soon' },
        { ...timer({ id: 'nan' }), deadline: Number.NaN },
        { ...timer({ id: 'blank-name' }), name: '   ' },
        { ...timer({ id: 'bad-status' }), status: 'paused' },
        { ...timer({ id: '' }) },
      ],
    });
    expect(parseTimers(raw, T0).map((t) => t.id)).toEqual(['ok']);
  });

  it('keeps a sound timer whose origin is broken, minus the origin', () => {
    const raw = JSON.stringify({
      version: TIMERS_SCHEMA_VERSION,
      savedAt: T0,
      timers: [{ ...timer({ id: 'a' }), origin: { stepIndex: 'two', label: 7 } }],
    });
    const [restored] = parseTimers(raw, T0);
    expect(restored.id).toBe('a');
    expect(restored.origin).toBeNull();
  });

  it('discards unknown fields instead of passing them through', () => {
    const raw = JSON.stringify({
      version: TIMERS_SCHEMA_VERSION,
      savedAt: T0,
      timers: [{ ...timer({ id: 'a' }), injected: '<script>' }],
    });
    expect(parseTimers(raw, T0)[0]).not.toHaveProperty('injected');
  });

  it('drops duplicate ids, which would collide as React keys', () => {
    const raw = JSON.stringify({
      version: TIMERS_SCHEMA_VERSION,
      savedAt: T0,
      timers: [timer({ id: 'a', name: 'first' }), timer({ id: 'a', name: 'second' })],
    });
    const restored = parseTimers(raw, T0);
    expect(restored).toHaveLength(1);
    expect(restored[0].name).toBe('first');
  });

  it('drops long-expired timers so a stale alarm does not greet the cook', () => {
    const raw = serializeTimers([timer({ deadline: T0 })], T0);
    expect(parseTimers(raw, T0 + OVERDUE_KEEP_MS)).toHaveLength(1);
    expect(parseTimers(raw, T0 + OVERDUE_KEEP_MS + 1)).toEqual([]);
  });

  it('caps how many timers a payload can restore', () => {
    const many = Array.from({ length: MAX_TIMERS + 5 }, (_, i) => timer({ id: `t${i}` }));
    const raw = JSON.stringify({ version: TIMERS_SCHEMA_VERSION, savedAt: T0, timers: many });
    expect(parseTimers(raw, T0)).toHaveLength(MAX_TIMERS);
  });
});

describe('storage round trip', () => {
  it('saves and loads through a Storage', () => {
    const storage = fakeStorage();
    const key = storageKey('user-1', 'sess-1');
    saveTimers(storage, key, [timer({ id: 'a' })], T0);
    expect(readBack(storage, key, T0).map((t) => t.id)).toEqual(['a']);
  });

  it('clears the key once nothing is running, rather than leaving an empty list', () => {
    const storage = fakeStorage();
    const key = storageKey('user-1', 'sess-1');
    saveTimers(storage, key, [timer({ id: 'a' })], T0);
    expect(storage.map.has(key)).toBe(true);

    saveTimers(storage, key, completeTimer([timer({ id: 'a' })], 'a'), T0);
    expect(storage.map.has(key)).toBe(false);
    expect(readBack(storage, key, T0)).toEqual([]);
  });

  it('never reads another session or another user', () => {
    const storage = fakeStorage();
    saveTimers(storage, storageKey('user-1', 'sess-1'), [timer({ id: 'mine' })], T0);
    saveTimers(storage, storageKey('user-2', 'sess-1'), [timer({ id: 'theirs' })], T0);
    saveTimers(storage, storageKey('user-1', 'sess-2'), [timer({ id: 'other-cook' })], T0);

    expect(readBack(storage, storageKey('user-1', 'sess-1'), T0).map((t) => t.id)).toEqual([
      'mine',
    ]);
    expect(readBack(storage, storageKey('user-2', 'sess-1'), T0).map((t) => t.id)).toEqual([
      'theirs',
    ]);
  });

  it('survives a Storage that throws on every call', () => {
    const storage = hostileStorage();
    const key = storageKey('user-1', 'sess-1');
    expect(() => saveTimers(storage, key, [timer()], T0)).not.toThrow();
    expect(readBack(storage, key, T0)).toEqual([]);
  });
});

describe('surviving a step change', () => {
  it('keeps timers from steps the cook has already left', () => {
    // The list is keyed by cooking session, never by step, so moving on cannot
    // drop a timer the way the old per-step component did.
    let list: CookingTimer[] = [];
    list = addTimer(
      list,
      createTimer({
        id: 'a',
        name: '工程1',
        durationMs: 10 * MINUTE,
        now: T0,
        origin: { stepIndex: 0, label: '工程1' },
      }),
    );
    list = addTimer(
      list,
      createTimer({
        id: 'b',
        name: '工程3',
        durationMs: 4 * MINUTE,
        now: T0 + MINUTE,
        origin: { stepIndex: 2, label: '工程3' },
      }),
    );

    // Three steps later, and through a reload, both are still counting.
    const restored = parseTimers(serializeTimers(list, T0 + MINUTE), T0 + 2 * MINUTE);
    expect(restored.map((t) => t.id)).toEqual(['a', 'b']);
    expect(restored[0].origin).toEqual({ stepIndex: 0, label: '工程1' });
    expect(remainingMs(restored[0], T0 + 2 * MINUTE)).toBe(8 * MINUTE);
  });
});
