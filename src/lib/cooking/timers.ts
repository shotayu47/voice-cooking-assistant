/**
 * Multiple cooking timers (PHASE 6) — pure state, formatting and persistence.
 *
 * Every value here derives from `deadline − Date.now()`. The PHASE 6 iPhone
 * measurement (`docs/phase6-timer-measurement.md`) ruled out the alternatives:
 *
 * - `performance.now()` froze during a screen lock. Wall time advanced 3:13
 *   while it advanced 1:19 — a 113,815ms divergence. It must never reach a
 *   remaining-time calculation.
 * - A backgrounded interval fired 2 times against 176, 193 and 1901 expected,
 *   so counting ticks under-reports elapsed time by whatever iOS throttled
 *   away.
 *
 * Ticks therefore decide only *when to repaint*; the value painted always comes
 * from the deadline. That is also why a timer survives a suspended page for
 * free — nothing has to keep running for the arithmetic to stay right.
 *
 * Kept free of I/O so it is directly testable: the storage helpers take a
 * `Storage` rather than reaching for `window`.
 */

/**
 * Bumped whenever the stored shape changes. It appears in the storage key as
 * well as the payload, so an older build's data lands under a different key and
 * is never handed to a parser that would not understand it.
 */
export const TIMERS_SCHEMA_VERSION = 1;

/** Enough for a full stove; a cap keeps stored data bounded. */
export const MAX_TIMERS = 8;

/** A whole cooking session's worth. Older payloads are not worth restoring. */
export const PAYLOAD_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * How long past its deadline a timer is still worth showing. Coming back to
 * 「時間を過ぎています」 an hour later is information; a day later is noise.
 */
export const OVERDUE_KEEP_MS = 60 * 60 * 1000;

export const STORAGE_PREFIX = 'tsugu:timers';

/**
 * `done` means the cook acknowledged it. Overdue is deliberately *not* a stored
 * state — it is a function of the current time, and storing it would let the
 * record disagree with the clock.
 */
export type TimerStatus = 'running' | 'done';

/** The step a timer was started from, when it came from one. */
export type TimerOrigin = {
  stepIndex: number;
  label: string;
};

export type CookingTimer = {
  id: string;
  name: string;
  /** Epoch ms. The single source of truth for how much time is left. */
  deadline: number;
  /** Epoch ms, for stable ordering of timers sharing a deadline. */
  createdAt: number;
  origin: TimerOrigin | null;
  status: TimerStatus;
};

/* -------------------------------------------------------------------------- */
/* Time                                                                       */
/* -------------------------------------------------------------------------- */

/** Never negative: past the deadline the answer is zero, not a countdown up. */
export function remainingMs(timer: CookingTimer, now: number): number {
  return Math.max(0, timer.deadline - now);
}

/** How far past the deadline we are, zero while still counting down. */
export function overdueMs(timer: CookingTimer, now: number): number {
  return Math.max(0, now - timer.deadline);
}

/** An acknowledged timer is finished, not overdue, however old it is. */
export function isOverdue(timer: CookingTimer, now: number): boolean {
  return timer.status === 'running' && now >= timer.deadline;
}

/**
 * `m:ss`, or `h:mm:ss` once there is an hour to show.
 *
 * Rounds up so a freshly started 5-minute timer reads `5:00` rather than
 * `4:59`, and only reaches `0:00` when the deadline has actually arrived.
 */
export function formatRemaining(ms: number): string {
  const total = Math.ceil(Math.max(0, ms) / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const ss = String(seconds).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${ss}` : `${minutes}:${ss}`;
}

/* -------------------------------------------------------------------------- */
/* List operations                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Falls back to the step it came from, then to a number that is not already
 * taken — reusing 「タイマー2」 while another 「タイマー2」 is on screen would
 * make the two impossible to tell apart.
 */
export function defaultTimerName(
  existing: readonly CookingTimer[],
  origin: TimerOrigin | null,
): string {
  const fromStep = origin?.label.trim();
  if (fromStep) return fromStep;

  const taken = new Set(existing.map((timer) => timer.name));
  let n = existing.length + 1;
  while (taken.has(`タイマー${n}`)) n += 1;
  return `タイマー${n}`;
}

export function createTimer(input: {
  id: string;
  name: string;
  durationMs: number;
  now: number;
  origin?: TimerOrigin | null;
}): CookingTimer {
  return {
    id: input.id,
    name: input.name.trim(),
    // A non-positive duration would otherwise produce a deadline in the past,
    // i.e. a timer that is born overdue.
    deadline: input.now + Math.max(0, input.durationMs),
    createdAt: input.now,
    origin: input.origin ?? null,
    status: 'running',
  };
}

/** At the cap the list is returned untouched; callers check `canAddTimer`. */
export function addTimer(
  timers: readonly CookingTimer[],
  timer: CookingTimer,
): CookingTimer[] {
  if (!canAddTimer(timers)) return [...timers];
  return [...timers, timer];
}

export function canAddTimer(timers: readonly CookingTimer[]): boolean {
  return timers.filter((timer) => timer.status === 'running').length < MAX_TIMERS;
}

export function removeTimer(timers: readonly CookingTimer[], id: string): CookingTimer[] {
  return timers.filter((timer) => timer.id !== id);
}

/** Acknowledge a timer. It stays on screen for the cook, but stops persisting. */
export function completeTimer(timers: readonly CookingTimer[], id: string): CookingTimer[] {
  return timers.map((timer) =>
    timer.id === id ? { ...timer, status: 'done' as const } : timer,
  );
}

export function renameTimer(
  timers: readonly CookingTimer[],
  id: string,
  name: string,
): CookingTimer[] {
  const trimmed = name.trim();
  if (!trimmed) return [...timers];
  return timers.map((timer) => (timer.id === id ? { ...timer, name: trimmed } : timer));
}

/**
 * Soonest deadline first, so whatever needs attention is at the top and an
 * overdue timer sorts above everything still counting down. Acknowledged ones
 * sink to the bottom.
 */
export function sortTimers(timers: readonly CookingTimer[]): CookingTimer[] {
  return [...timers].sort((a, b) => {
    if (a.status !== b.status) return a.status === 'done' ? 1 : -1;
    if (a.deadline !== b.deadline) return a.deadline - b.deadline;
    return a.createdAt - b.createdAt;
  });
}

/* -------------------------------------------------------------------------- */
/* Persistence                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Scoped to both the user and the cooking session, so one cook's timers can
 * never be read into another's screen — including when two accounts share a
 * phone and therefore share an origin's `localStorage`.
 */
export function storageKey(userId: string | null, sessionId: string): string {
  return `${STORAGE_PREFIX}:v${TIMERS_SCHEMA_VERSION}:${userId ?? 'anon'}:${sessionId}`;
}

/**
 * Keys written by a previous schema version. They can never be parsed by this
 * build, so sweeping them is pure cleanup rather than data loss.
 */
export function obsoleteTimerKeys(keys: readonly string[]): string[] {
  const current = `${STORAGE_PREFIX}:v${TIMERS_SCHEMA_VERSION}:`;
  return keys.filter((key) => key.startsWith(`${STORAGE_PREFIX}:`) && !key.startsWith(current));
}

type StoredPayload = {
  version: number;
  savedAt: number;
  timers: CookingTimer[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function reviveOrigin(value: unknown): TimerOrigin | null {
  if (!isRecord(value)) return null;
  const { stepIndex, label } = value;
  if (!isFiniteNumber(stepIndex) || typeof label !== 'string' || !label.trim()) return null;
  return { stepIndex, label };
}

/**
 * Rebuilds a timer field by field rather than trusting the parsed object.
 * Anything unrecognised yields `null` and is dropped, so a hand-edited or
 * truncated record can never reach the render as `undefined`.
 */
function reviveTimer(value: unknown): CookingTimer | null {
  if (!isRecord(value)) return null;
  const { id, name, deadline, createdAt, status, origin } = value;

  if (typeof id !== 'string' || !id) return null;
  if (typeof name !== 'string' || !name.trim()) return null;
  if (!isFiniteNumber(deadline) || !isFiniteNumber(createdAt)) return null;
  if (status !== 'running' && status !== 'done') return null;

  return { id, name, deadline, createdAt, status, origin: reviveOrigin(origin) };
}

/** Acknowledged timers are dropped here — that is what "removed on complete" means. */
export function serializeTimers(timers: readonly CookingTimer[], now: number): string {
  const payload: StoredPayload = {
    version: TIMERS_SCHEMA_VERSION,
    savedAt: now,
    timers: timers.filter((timer) => timer.status === 'running'),
  };
  return JSON.stringify(payload);
}

/**
 * Returns `[]` for anything it cannot vouch for: unparseable JSON, a foreign
 * schema version, a payload older than a day, or individual records that fail
 * revival. Never throws — a corrupt entry must not be able to blank the screen.
 */
export function parseTimers(raw: string | null | undefined, now: number): CookingTimer[] {
  if (!raw) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  if (!isRecord(parsed)) return [];
  if (parsed.version !== TIMERS_SCHEMA_VERSION) return [];
  if (!isFiniteNumber(parsed.savedAt)) return [];
  if (now - parsed.savedAt > PAYLOAD_MAX_AGE_MS) return [];
  if (!Array.isArray(parsed.timers)) return [];

  const seen = new Set<string>();
  const timers: CookingTimer[] = [];

  for (const entry of parsed.timers) {
    const timer = reviveTimer(entry);
    if (!timer) continue;
    // A duplicate id would collide as a React key and make one of the two
    // impossible to remove.
    if (seen.has(timer.id)) continue;
    // Long expired: restoring it would greet the cook with a stale alarm.
    if (now - timer.deadline > OVERDUE_KEEP_MS) continue;
    seen.add(timer.id);
    timers.push(timer);
  }

  return timers.slice(0, MAX_TIMERS);
}

/** The subset of `Storage` used here, so tests can pass a plain object. */
export type TimerStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/**
 * Writes the running timers, or clears the key when there are none left — so
 * finishing a cook leaves nothing behind rather than an empty array.
 *
 * Storage access is best-effort: Private Browsing throws on every call, and a
 * cook that cannot be persisted is still a cook that should run.
 */
export function saveTimers(
  storage: TimerStorage,
  key: string,
  timers: readonly CookingTimer[],
  now: number,
): void {
  try {
    if (!timers.some((timer) => timer.status === 'running')) {
      storage.removeItem(key);
      return;
    }
    storage.setItem(key, serializeTimers(timers, now));
  } catch {
    // Quota or Private Browsing. The timers still work for this document; only
    // surviving a reload is lost, and that is not worth breaking the cook over.
  }
}
