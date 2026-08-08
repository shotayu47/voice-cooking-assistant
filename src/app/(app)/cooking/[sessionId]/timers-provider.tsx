'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';

import {
  addTimer,
  canAddTimer,
  completeTimer,
  createTimer,
  defaultTimerName,
  obsoleteTimerKeys,
  parseTimers,
  removeTimer,
  saveTimers,
  sortTimers,
  storageKey,
  type CookingTimer,
  type TimerOrigin,
} from '@/lib/cooking/timers';

/** Shared identity so an empty list never looks like a change. */
const EMPTY: CookingTimer[] = [];

function readRaw(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    // Private Browsing. Treated as "nothing stored" rather than an error.
    return null;
  }
}

/**
 * `localStorage` as a React external store, one instance per storage key.
 *
 * Keeping the persisted copy authoritative — rather than mirroring a `useState`
 * into it — is what makes a process restart a non-event: the first render after
 * the document is recreated already reads the restored timers, with no effect
 * having to run first. It also means a second tab editing the same cook is
 * picked up through the `storage` event.
 */
class TimerStore {
  private listeners = new Set<() => void>();
  /** The raw string the cache was built from. `undefined` = must re-read. */
  private raw: string | null | undefined = undefined;
  private cache: CookingTimer[] = EMPTY;
  private swept = false;

  constructor(private readonly key: string) {}

  subscribe = (listener: () => void): (() => void) => {
    // Bound to the first and last subscriber rather than to each one: with
    // several components subscribed, `addEventListener` would dedupe on the
    // shared handler reference and the first unsubscribe would then remove it
    // out from under the rest.
    if (this.listeners.size === 0) {
      // The earliest safe moment for side effects — subscribe runs in an
      // effect, not during render.
      if (!this.swept) {
        this.swept = true;
        try {
          for (const stale of obsoleteTimerKeys(Object.keys(window.localStorage))) {
            window.localStorage.removeItem(stale);
          }
        } catch {
          /* nothing reachable to clean up */
        }
      }
      window.addEventListener('storage', this.onStorage);
    }

    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) {
        window.removeEventListener('storage', this.onStorage);
      }
    };
  };

  /**
   * Must stay referentially stable while nothing has changed, or React would
   * re-render forever. The parsed list is cached against the exact string it
   * came from.
   */
  getSnapshot = (): CookingTimer[] => {
    const current = readRaw(this.key);
    if (current !== this.raw) {
      this.raw = current;
      this.cache = parseTimers(current, Date.now());
    }
    return this.cache;
  };

  /** The server has no storage; the client re-reads right after hydration. */
  getServerSnapshot = (): CookingTimer[] => EMPTY;

  update = (change: (current: readonly CookingTimer[]) => CookingTimer[]): void => {
    const next = change(this.getSnapshot());
    saveTimers(window.localStorage, this.key, next, Date.now());
    // The cache, not storage, is what the screen shows: `saveTimers` drops
    // acknowledged timers, but the cook should still see them until they clear
    // them. Re-reading the raw string keeps `getSnapshot` from noticing the
    // difference and re-parsing them away.
    this.cache = next;
    this.raw = readRaw(this.key);
    for (const listener of this.listeners) listener();
  };

  private onStorage = (event: StorageEvent): void => {
    // A null key means the whole store was cleared.
    if (event.key !== null && event.key !== this.key) return;
    this.raw = undefined;
    for (const listener of this.listeners) listener();
  };
}

const stores = new Map<string, TimerStore>();

function getStore(key: string): TimerStore {
  const existing = stores.get(key);
  if (existing) return existing;
  const created = new TimerStore(key);
  stores.set(key, created);
  return created;
}

type StartInput = {
  durationMs: number;
  name?: string;
  origin?: TimerOrigin | null;
};

type TimersValue = {
  /** Sorted for display: whatever needs attention first. */
  timers: CookingTimer[];
  /** The wall clock every countdown is rendered against. */
  now: number;
  canAdd: boolean;
  start: (input: StartInput) => void;
  complete: (id: string) => void;
  dismiss: (id: string) => void;
};

const TimersContext = createContext<TimersValue | null>(null);

function newTimerId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `t-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

/**
 * Holds every timer for one cooking session.
 *
 * Lives above the step screen on purpose. The old `StepTimer` was mounted with
 * `key={currentStep}`, so moving to the next step unmounted it and silently
 * threw the countdown away — the single thing PHASE 6 exists to fix.
 *
 * The clock here is only a repaint trigger. Remaining time is always recomputed
 * from each timer's deadline, so an interval that iOS throttled to 2 ticks in
 * half an hour (measurement Test D) costs nothing but a stale-looking screen
 * until the next repaint — which `visibilitychange` forces immediately.
 */
export function CookingTimersProvider({
  userId,
  sessionId,
  children,
}: {
  userId: string | null;
  sessionId: string;
  children: React.ReactNode;
}) {
  const store = useMemo(() => getStore(storageKey(userId, sessionId)), [userId, sessionId]);
  const timers = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getServerSnapshot,
  );

  const [now, setNow] = useState(() => Date.now());

  // Only tick while something is counting: an idle cooking screen should not
  // wake once a second for nothing.
  const hasRunning = timers.some((timer) => timer.status === 'running');
  useEffect(() => {
    if (!hasRunning) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [hasRunning]);

  // Coming back to the page is the moment the display is most wrong — iOS fires
  // almost no ticks while it is away (2 against 1901 expected in the
  // measurement). Recomputing `now` here re-derives every countdown from its
  // deadline before the next paint.
  useEffect(() => {
    const resync = () => {
      if (document.visibilityState !== 'visible') return;
      setNow(Date.now());
    };

    document.addEventListener('visibilitychange', resync);
    // `pageshow` covers a bfcache restore and `focus` the cases iOS reports as
    // neither. All three are cheap and idempotent, so registering them costs
    // nothing and closes the gaps between browsers.
    window.addEventListener('pageshow', resync);
    window.addEventListener('focus', resync);

    return () => {
      document.removeEventListener('visibilitychange', resync);
      window.removeEventListener('pageshow', resync);
      window.removeEventListener('focus', resync);
    };
  }, []);

  const start = useCallback(
    (input: StartInput) => {
      // One timestamp for both the deadline and the repaint, so the first
      // frame cannot show a countdown that already lost a few milliseconds.
      const at = Date.now();
      setNow(at);
      store.update((current) => {
        if (!canAddTimer(current)) return [...current];
        const origin = input.origin ?? null;
        const name = input.name?.trim() || defaultTimerName(current, origin);
        return addTimer(
          current,
          createTimer({ id: newTimerId(), name, durationMs: input.durationMs, now: at, origin }),
        );
      });
    },
    [store],
  );

  const complete = useCallback(
    (id: string) => store.update((current) => completeTimer(current, id)),
    [store],
  );

  const dismiss = useCallback(
    (id: string) => store.update((current) => removeTimer(current, id)),
    [store],
  );

  const value = useMemo<TimersValue>(
    () => ({
      timers: sortTimers(timers),
      now,
      canAdd: canAddTimer(timers),
      start,
      complete,
      dismiss,
    }),
    [timers, now, start, complete, dismiss],
  );

  return <TimersContext.Provider value={value}>{children}</TimersContext.Provider>;
}

export function useCookingTimers(): TimersValue {
  const value = useContext(TimersContext);
  if (!value) {
    throw new Error('useCookingTimers must be used inside a CookingTimersProvider');
  }
  return value;
}
