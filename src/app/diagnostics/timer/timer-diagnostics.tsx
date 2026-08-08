'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { cn } from '@/lib/cn';
import {
  appendLog,
  classifyLaunch,
  clockSkew,
  formatDuration,
  formatGap,
  GAP_LOG_THRESHOLD_MS,
  LAUNCH_KEY,
  LAUNCH_LABEL,
  LOG_LIMIT,
  remainingMs,
  SESSION_KEY,
  TICK_MS,
  type DiagLogEntry,
  type LaunchKind,
} from '@/lib/diagnostics/timer-diag';

type Env = {
  standalone: boolean;
  displayMode: string;
  navigatorStandalone: boolean | null;
  hasNotification: boolean;
  permission: string;
  hasServiceWorker: boolean;
  registrations: number | null;
  registrationScopes: string[];
  hasFreezeEvents: boolean;
  secureContext: boolean;
  userAgent: string;
};

type Stats = {
  ticks: number;
  lastGap: number | null;
  maxGap: number | null;
  lastPerfGap: number | null;
  maxPerfGap: number | null;
  resumes: number;
  hiddenSpans: number;
};

type StoredSession = {
  instanceId: string;
  deadline: number | null;
  startedAt: number | null;
  durationMs: number | null;
  lastEventAt: number;
  log: DiagLogEntry[];
};

type Boot = {
  instanceId: string;
  launchKind: LaunchKind;
  launches: number;
  previous: StoredSession | null;
  deadline: number | null;
  startedAt: number | null;
  durationMs: number | null;
  log: DiagLogEntry[];
};

const EMPTY_STATS: Stats = {
  ticks: 0,
  lastGap: null,
  maxGap: null,
  lastPerfGap: null,
  maxPerfGap: null,
  resumes: 0,
  hiddenSpans: 0,
};

function readSession(): StoredSession | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredSession;
    return typeof parsed?.instanceId === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

function readLaunches(): number {
  try {
    return Number(localStorage.getItem(LAUNCH_KEY) ?? '0') || 0;
  } catch {
    return 0;
  }
}

function newInstanceId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID().slice(0, 8)
    : String(Math.floor(Math.random() * 1e9));
}

/**
 * Reads-only. The matching writes happen in an effect, so this stays safe to
 * run twice under React's development double-invoke.
 */
function readBoot(): Boot {
  const previous = readSession();
  const previousLaunches = readLaunches();
  const launchKind = classifyLaunch(Boolean(previous), previousLaunches);
  const instanceId = newInstanceId();
  const restored = Array.isArray(previous?.log) ? previous.log.slice(0, LOG_LIMIT) : [];
  const lastId = restored.reduce((max, e) => Math.max(max, e.id), 0);

  const detail =
    previous && typeof previous.lastEventAt === 'number'
      ? `前インスタンス ${previous.instanceId} / 最終イベントから ${formatGap(
          Date.now() - previous.lastEventAt,
        )}`
      : undefined;

  const bootEntry: DiagLogEntry = {
    id: lastId + 1,
    at: Date.now(),
    kind: `起動 (${launchKind})`,
    detail: [`instance ${instanceId}`, `起動 ${previousLaunches + 1} 回目`, detail]
      .filter(Boolean)
      .join(' / '),
  };

  return {
    instanceId,
    launchKind,
    launches: previousLaunches + 1,
    previous,
    // A countdown that was running before the document died is exactly what
    // test D needs to see, so the deadline is carried across instances. This
    // is diagnostics-only: the production timer in step-timer.tsx is untouched.
    deadline: previous?.deadline ?? null,
    startedAt: previous?.startedAt ?? null,
    durationMs: previous?.durationMs ?? null,
    log: appendLog(restored, bootEntry),
  };
}

function readEnv(): Env {
  const nav = navigator as Navigator & { standalone?: boolean };
  const matches = (query: string) =>
    typeof window.matchMedia === 'function' && window.matchMedia(query).matches;
  const displayMode =
    ['standalone', 'fullscreen', 'minimal-ui', 'browser'].find((mode) =>
      matches(`(display-mode: ${mode})`),
    ) ?? 'unknown';

  return {
    standalone: matches('(display-mode: standalone)') || nav.standalone === true,
    displayMode,
    navigatorStandalone: typeof nav.standalone === 'boolean' ? nav.standalone : null,
    hasNotification: 'Notification' in window,
    permission: 'Notification' in window ? Notification.permission : 'unsupported',
    hasServiceWorker: 'serviceWorker' in navigator,
    registrations: null,
    registrationScopes: [],
    hasFreezeEvents: 'onfreeze' in document,
    secureContext: window.isSecureContext,
    userAgent: navigator.userAgent,
  };
}

function clockOf(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function TimerDiagnostics() {
  const [boot] = useState(readBoot);
  const [env, setEnv] = useState(readEnv);
  const [now, setNow] = useState(() => Date.now());
  const [deadline, setDeadline] = useState<number | null>(boot.deadline);
  const [startedAt, setStartedAt] = useState<number | null>(boot.startedAt);
  const [durationMs, setDurationMs] = useState<number | null>(boot.durationMs);
  const [stats, setStats] = useState<Stats>(EMPTY_STATS);
  const [log, setLog] = useState<DiagLogEntry[]>(boot.log);
  const [visibility, setVisibility] = useState(() => document.visibilityState as string);
  const [launches, setLaunches] = useState(boot.launches);
  const [previous, setPrevious] = useState(boot.previous);

  const logIdRef = useRef(boot.log.reduce((max, e) => Math.max(max, e.id), 0));
  const lastWallRef = useRef<number | null>(null);
  const lastPerfRef = useRef<number | null>(null);
  const hiddenAtRef = useRef<number | null>(null);
  const hiddenPerfRef = useRef<number | null>(null);
  const hiddenTicksRef = useRef(0);

  // Mirrors what belongs in storage, so persisting never has to be a render
  // dependency (which would restart the interval we are trying to measure).
  const stateRef = useRef({
    instanceId: boot.instanceId,
    deadline: boot.deadline,
    startedAt: boot.startedAt,
    durationMs: boot.durationMs,
    log: boot.log,
  });

  const persist = useCallback(() => {
    try {
      const s = stateRef.current;
      const record: StoredSession = {
        instanceId: s.instanceId,
        deadline: s.deadline,
        startedAt: s.startedAt,
        durationMs: s.durationMs,
        lastEventAt: Date.now(),
        log: s.log,
      };
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(record));
    } catch {
      /* diagnostics only — a storage failure must not break the page */
    }
  }, []);

  const addLog = useCallback(
    (kind: string, detail?: string) => {
      const entry: DiagLogEntry = { id: ++logIdRef.current, at: Date.now(), kind, detail };
      setLog((current) => {
        const next = appendLog(current, entry);
        stateRef.current.log = next;
        return next;
      });
      persist();
    },
    [persist],
  );

  // Write side of the boot read above.
  useEffect(() => {
    try {
      localStorage.setItem(LAUNCH_KEY, String(boot.launches));
    } catch {
      /* ignore */
    }
    persist();
  }, [boot.launches, persist]);

  // Read-only probe. This page deliberately does not register a service worker.
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    let cancelled = false;

    navigator.serviceWorker
      .getRegistrations()
      .then((regs) => {
        if (cancelled) return;
        setEnv((current) => ({
          ...current,
          registrations: regs.length,
          registrationScopes: regs.map((r) => r.scope),
        }));
      })
      .catch(() => {
        if (cancelled) return;
        setEnv((current) => ({ ...current, registrations: -1 }));
      });

    return () => {
      cancelled = true;
    };
  }, []);

  // The interval runs for the whole life of the page, not only while a
  // countdown is active: the firing gap is itself one of the measurements.
  useEffect(() => {
    lastWallRef.current = Date.now();
    lastPerfRef.current = performance.now();
    let sincePersist = 0;

    const id = setInterval(() => {
      const wall = Date.now();
      const perf = performance.now();
      const gap = lastWallRef.current === null ? null : wall - lastWallRef.current;
      const perfGap = lastPerfRef.current === null ? null : perf - lastPerfRef.current;
      lastWallRef.current = wall;
      lastPerfRef.current = perf;

      setNow(wall);
      setStats((current) => ({
        ...current,
        ticks: current.ticks + 1,
        lastGap: gap,
        maxGap: gap === null ? current.maxGap : Math.max(current.maxGap ?? 0, gap),
        lastPerfGap: perfGap,
        maxPerfGap:
          perfGap === null ? current.maxPerfGap : Math.max(current.maxPerfGap ?? 0, perfGap),
      }));

      if (gap !== null && gap >= GAP_LOG_THRESHOLD_MS) {
        addLog(
          'interval gap',
          `${formatGap(gap)}（想定 ${TICK_MS}ms） / perf ${formatGap(perfGap)} / ずれ ${
            perfGap === null ? '—' : `${Math.round(clockSkew(gap, perfGap))}ms`
          } / visibility ${document.visibilityState}`,
        );
      }

      sincePersist += 1;
      if (sincePersist >= 5) {
        sincePersist = 0;
        persist();
      }
    }, TICK_MS);

    return () => clearInterval(id);
  }, [addLog, persist]);

  // `freeze`/`resume` are registered unconditionally; if Safari never fires
  // them, their absence from the log is itself the finding.
  useEffect(() => {
    const onVisibility = () => {
      const state = document.visibilityState;
      setVisibility(state);

      if (state === 'hidden') {
        hiddenAtRef.current = Date.now();
        hiddenPerfRef.current = performance.now();
        setStats((current) => {
          hiddenTicksRef.current = current.ticks;
          return { ...current, hiddenSpans: current.hiddenSpans + 1 };
        });
        addLog('visibilitychange → hidden');
        return;
      }

      const hiddenAt = hiddenAtRef.current;
      const hiddenPerf = hiddenPerfRef.current;
      if (hiddenAt === null || hiddenPerf === null) {
        addLog(`visibilitychange → ${state}`);
        return;
      }

      const wallAway = Date.now() - hiddenAt;
      const perfAway = performance.now() - hiddenPerf;
      setStats((current) => {
        const ticksAway = current.ticks - hiddenTicksRef.current;
        addLog(
          'visibilitychange → visible',
          `実経過 ${formatGap(wallAway)} / perf経過 ${formatGap(perfAway)} / ずれ ${Math.round(
            clockSkew(wallAway, perfAway),
          )}ms / 背面中の tick ${ticksAway} 回（想定 ${Math.round(wallAway / TICK_MS)} 回）`,
        );
        return { ...current, resumes: current.resumes + 1 };
      });
      hiddenAtRef.current = null;
      hiddenPerfRef.current = null;
    };

    const onPageHide = (e: PageTransitionEvent) => addLog('pagehide', `persisted=${e.persisted}`);
    const onPageShow = (e: PageTransitionEvent) =>
      addLog('pageshow', `persisted=${e.persisted}${e.persisted ? '（bfcache から復帰）' : ''}`);
    const onFocus = () => addLog('focus');
    const onBlur = () => addLog('blur');
    const onFreeze = () => addLog('freeze', 'ページが凍結された');
    const onResume = () => addLog('resume', '凍結から復帰した');

    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('pageshow', onPageShow);
    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);
    document.addEventListener('freeze', onFreeze);
    document.addEventListener('resume', onResume);

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('pageshow', onPageShow);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('freeze', onFreeze);
      document.removeEventListener('resume', onResume);
    };
  }, [addLog]);

  const start = useCallback(
    (minutes: number) => {
      const at = Date.now();
      const ms = minutes * 60_000;
      const end = at + ms;
      setStartedAt(at);
      setDurationMs(ms);
      setDeadline(end);
      setNow(at);
      // Zero the tick counter as well as the gaps: "tick-derived elapsed" is
      // only comparable with "real elapsed" if both are counted from the same
      // moment, and real elapsed is measured from the start of the timer.
      setStats((current) => ({ ...current, ticks: 0, maxGap: null, maxPerfGap: null }));
      stateRef.current.startedAt = at;
      stateRef.current.durationMs = ms;
      stateRef.current.deadline = end;
      addLog('timer start', `${minutes}分 / deadline ${clockOf(end)} (${end})`);
    },
    [addLog],
  );

  const reset = useCallback(() => {
    setDeadline(null);
    setStartedAt(null);
    setDurationMs(null);
    setStats(EMPTY_STATS);
    stateRef.current.deadline = null;
    stateRef.current.startedAt = null;
    stateRef.current.durationMs = null;
    addLog('reset');
  }, [addLog]);

  const testNotificationPermission = useCallback(() => {
    if (!('Notification' in window)) {
      addLog('通知テスト', 'Notification API そのものが存在しない');
      return;
    }
    addLog('通知テスト', `要求前の permission=${Notification.permission}`);
    Notification.requestPermission()
      .then((permission) => {
        setEnv((current) => ({ ...current, permission }));
        addLog('通知テスト', `要求後の permission=${permission}`);
      })
      .catch((error: unknown) => {
        addLog('通知テスト', `requestPermission が失敗: ${String(error)}`);
      });
  }, [addLog]);

  const clearDiagnostics = useCallback(() => {
    try {
      sessionStorage.removeItem(SESSION_KEY);
      localStorage.removeItem(LAUNCH_KEY);
    } catch {
      /* ignore */
    }
    setLog([]);
    stateRef.current.log = [];
    setLaunches(0);
    setPrevious(null);
    reset();
  }, [reset]);

  const left = remainingMs(deadline, now);
  const elapsed = startedAt === null ? null : now - startedAt;

  return (
    <div className="mx-auto w-full max-w-md px-4 pb-24 pt-6">
      <header className="mb-6">
        <p className="text-xs font-semibold uppercase tracking-widest text-accent">
          Diagnostics — 製品機能ではありません
        </p>
        <h1 className="mt-1 text-xl font-bold">タイマー挙動の実測</h1>
        <p className="mt-2 text-sm text-muted">
          PHASE 6（複数タイマー）の設計を実測で決めるためのページです。残り時間は必ず
          <code className="mx-1">deadline − Date.now()</code>
          から求めており、interval の発火回数からは計算していません。
        </p>
      </header>

      <section className="mb-6 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => start(5)}
          className="min-h-11 rounded-lg border border-accent/40 bg-accent/10 px-4 text-sm font-medium text-accent"
        >
          5分タイマー開始
        </button>
        <button
          type="button"
          onClick={() => start(10)}
          className="min-h-11 rounded-lg border border-accent/40 bg-accent/10 px-4 text-sm font-medium text-accent"
        >
          10分タイマー開始
        </button>
        <button
          type="button"
          onClick={reset}
          className="min-h-11 rounded-lg border border-line px-4 text-sm"
        >
          リセット
        </button>
      </section>

      <Panel title="タイマー">
        <Row label="残り（deadline基準）" value={left === null ? '—' : formatDuration(left)} mono />
        <Row label="開始時刻" value={startedAt === null ? '—' : clockOf(startedAt)} mono />
        <Row label="deadline" value={deadline === null ? '—' : clockOf(deadline)} mono />
        <Row label="現在時刻" value={clockOf(now)} mono />
        <Row label="設定時間" value={durationMs === null ? '—' : formatDuration(durationMs)} mono />
        <Row
          label="実経過（Date.now基準）"
          value={elapsed === null ? '—' : formatDuration(elapsed)}
          mono
        />
        <Row
          label="tick由来の経過（比較用）"
          value={formatDuration(stats.ticks * TICK_MS)}
          hint="発火回数 × 1000ms。実経過との差が、絞られた分です"
          mono
        />
      </Panel>

      <Panel title="interval">
        <Row label="発火回数" value={String(stats.ticks)} mono />
        <Row label="直近の発火間隔" value={formatGap(stats.lastGap)} mono />
        <Row label="最大ギャップ" value={formatGap(stats.maxGap)} hint={`想定は ${TICK_MS}ms`} mono />
        <Row label="直近 performance.now 差" value={formatGap(stats.lastPerfGap)} mono />
        <Row label="最大 performance.now 差" value={formatGap(stats.maxPerfGap)} mono />
      </Panel>

      <Panel title="ページの状態">
        <Row label="visibilityState" value={visibility} mono />
        <Row label="復帰回数" value={String(stats.resumes)} mono />
        <Row label="背面に入った回数" value={String(stats.hiddenSpans)} mono />
        <Row label="instance ID" value={boot.instanceId} mono />
        <Row label="起動回数" value={String(launches)} mono />
        <Row label="この起動の種類" value={LAUNCH_LABEL[boot.launchKind]} />
        <Row
          label="前インスタンスの最終イベント"
          value={
            previous?.lastEventAt
              ? `${clockOf(previous.lastEventAt)}（${previous.instanceId}）`
              : '—'
          }
        />
      </Panel>

      <Panel title="この端末で使えるもの">
        <Row label="standalone 起動" value={env.standalone ? 'はい' : 'いいえ'} />
        <Row label="display-mode" value={env.displayMode} mono />
        <Row
          label="navigator.standalone"
          value={env.navigatorStandalone === null ? '未定義' : String(env.navigatorStandalone)}
          mono
        />
        <Row label="Notification API" value={env.hasNotification ? 'あり' : 'なし'} />
        <Row label="Notification.permission" value={env.permission} mono />
        <Row label="Service Worker API" value={env.hasServiceWorker ? 'あり' : 'なし'} />
        <Row
          label="登録済み Service Worker"
          value={
            env.registrations === null
              ? '確認中…'
              : env.registrations === -1
                ? '取得に失敗'
                : `${env.registrations} 件${
                    env.registrationScopes.length ? `（${env.registrationScopes.join(', ')}）` : ''
                  }`
          }
        />
        <Row label="freeze / resume イベント" value={env.hasFreezeEvents ? 'あり' : 'なし'} />
        <Row label="secure context" value={String(env.secureContext)} mono />
      </Panel>

      <section className="mb-6">
        <button
          type="button"
          onClick={testNotificationPermission}
          className="min-h-11 w-full rounded-lg border border-line px-4 text-sm"
        >
          通知権限をテスト（この操作でのみ要求します）
        </button>
        <p className="mt-2 text-xs text-muted">
          ページを開いただけでは通知の許可を要求しません。Service Worker もこのページでは
          登録しません（存在の確認のみ）。
        </p>
      </section>

      <Panel title={`イベントログ（最新 ${LOG_LIMIT} 件まで）`}>
        <ul className="divide-y divide-line">
          {log.length === 0 ? (
            <li className="py-2 text-sm text-muted">まだイベントはありません</li>
          ) : (
            log.map((entry) => (
              <li key={entry.id} className="py-2 text-sm">
                <span className="mr-2 tabular-nums text-muted">{clockOf(entry.at)}</span>
                <span className="font-medium">{entry.kind}</span>
                {entry.detail ? (
                  <span className="mt-0.5 block text-xs text-muted">{entry.detail}</span>
                ) : null}
              </li>
            ))
          )}
        </ul>
      </Panel>

      <button
        type="button"
        onClick={clearDiagnostics}
        className="min-h-11 w-full rounded-lg border border-line px-4 text-sm text-muted"
      >
        診断データを消去（このページ専用の保存領域のみ）
      </button>

      <p className="mt-4 break-all text-xs text-muted">{env.userAgent}</p>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-6 rounded-xl border border-line p-4">
      <h2 className="mb-3 text-sm font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function Row({
  label,
  value,
  hint,
  mono,
}: {
  label: string;
  value: string;
  hint?: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <div className="min-w-0">
        <span className="text-sm text-muted">{label}</span>
        {hint ? <span className="block text-xs text-muted/70">{hint}</span> : null}
      </div>
      <span className={cn('shrink-0 text-sm', mono && 'font-medium tabular-nums')}>{value}</span>
    </div>
  );
}
