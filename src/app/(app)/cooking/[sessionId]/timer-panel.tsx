'use client';

import { useState } from 'react';

import { cn } from '@/lib/cn';
import {
  formatRemaining,
  isOverdue,
  MAX_TIMERS,
  overdueMs,
  remainingMs,
  type CookingTimer,
} from '@/lib/cooking/timers';

import { useCookingTimers } from './timers-provider';

const MAX_MINUTES = 600;

/**
 * Every timer for this cook, on every step.
 *
 * Rendered outside the step body so it stays put while the cook moves through
 * the recipe — a pot does not stop boiling because you read ahead.
 */
export function TimerPanel() {
  const { timers, now, canAdd } = useCookingTimers();
  const [adding, setAdding] = useState(false);

  if (timers.length === 0 && !adding) {
    return (
      <button
        type="button"
        onClick={() => setAdding(true)}
        className="min-h-11 w-full rounded-xl border border-dashed border-line text-sm text-muted active:bg-surface-2"
      >
        タイマーを追加
      </button>
    );
  }

  return (
    <section className="space-y-2" aria-label="タイマー">
      <ul className="space-y-2">
        {timers.map((timer) => (
          <TimerRow key={timer.id} timer={timer} now={now} />
        ))}
      </ul>

      {adding ? (
        <AddTimerForm onClose={() => setAdding(false)} />
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          disabled={!canAdd}
          className="min-h-11 w-full rounded-xl border border-dashed border-line text-sm text-muted active:bg-surface-2 disabled:opacity-40"
        >
          {canAdd ? 'タイマーを追加' : `タイマーは${MAX_TIMERS}個までです`}
        </button>
      )}
    </section>
  );
}

function TimerRow({ timer, now }: { timer: CookingTimer; now: number }) {
  const { complete, dismiss } = useCookingTimers();
  const done = timer.status === 'done';
  const over = isOverdue(timer, now);

  return (
    <li
      className={cn(
        'flex items-center gap-3 rounded-xl border px-3 py-2',
        done
          ? 'border-line bg-surface opacity-60'
          : over
            ? 'border-warn/40 bg-warn/10'
            : 'border-line bg-surface',
      )}
    >
      <div className="min-w-0 flex-1">
        <p className={cn('truncate text-sm', done && 'line-through')}>{timer.name}</p>
        <p
          className={cn(
            'text-xs',
            done ? 'text-faint' : over ? 'text-warn' : 'text-muted',
          )}
        >
          {done
            ? '完了'
            : over
              ? `時間を過ぎています（${formatRemaining(overdueMs(timer, now))} 超過）`
              : '残り'}
        </p>

        {/*
          The visible line above counts up every second, so it cannot carry the
          live region — a screen reader would re-announce it on every tick. This
          says the one thing worth hearing, once, when it becomes true. On iOS
          there is no way to ring (the measurement found no Notification API in
          a Safari tab), so this is what tells a cook who is not looking.
        */}
        {over ? <span role="status" className="sr-only">{timer.name}の時間を過ぎています</span> : null}
      </div>

      {!done ? (
        <span
          className={cn(
            'shrink-0 text-lg font-bold tabular-nums',
            over ? 'text-warn' : 'text-fg',
          )}
        >
          {formatRemaining(remainingMs(timer, now))}
        </span>
      ) : null}

      {!done ? (
        <button
          type="button"
          onClick={() => complete(timer.id)}
          className="min-h-11 shrink-0 rounded-lg border border-line px-3 text-sm text-muted active:bg-surface-2"
        >
          完了
        </button>
      ) : null}

      <button
        type="button"
        onClick={() => dismiss(timer.id)}
        aria-label={`${timer.name}を消す`}
        className="min-h-11 w-11 shrink-0 rounded-lg text-lg text-faint active:bg-surface-2"
      >
        ✕
      </button>
    </li>
  );
}

function AddTimerForm({ onClose }: { onClose: () => void }) {
  const { start, canAdd } = useCookingTimers();
  const [name, setName] = useState('');
  const [minutes, setMinutes] = useState('5');

  const parsed = Number(minutes);
  const valid = Number.isFinite(parsed) && parsed > 0 && parsed <= MAX_MINUTES;

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!valid || !canAdd) return;
    // An empty name is not an error — the store names it after the step, or
    // numbers it.
    start({ durationMs: Math.round(parsed * 60_000), name });
    setName('');
    setMinutes('5');
    onClose();
  }

  return (
    <form onSubmit={submit} className="space-y-2 rounded-xl border border-line bg-surface p-3">
      <div className="flex gap-2">
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="名前（任意）"
          maxLength={40}
          className="min-h-11 min-w-0 flex-1 rounded-lg border border-line bg-bg px-3 text-sm"
        />
        <label className="flex min-h-11 shrink-0 items-center gap-1 rounded-lg border border-line bg-bg px-3">
          <input
            value={minutes}
            onChange={(event) => setMinutes(event.target.value)}
            type="number"
            inputMode="numeric"
            min={1}
            max={MAX_MINUTES}
            aria-label="分"
            className="w-12 bg-transparent text-right text-sm tabular-nums"
          />
          <span className="text-sm text-muted">分</span>
        </label>
      </div>

      <div className="flex gap-2">
        <button
          type="button"
          onClick={onClose}
          className="min-h-11 flex-1 rounded-lg border border-line text-sm text-muted active:bg-surface-2"
        >
          やめる
        </button>
        <button
          type="submit"
          disabled={!valid || !canAdd}
          className="min-h-11 flex-1 rounded-lg bg-accent text-sm font-medium text-on-accent active:bg-accent-strong disabled:opacity-40"
        >
          開始
        </button>
      </div>
    </form>
  );
}
