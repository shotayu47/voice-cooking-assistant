'use client';

import { cn } from '@/lib/cn';
import { formatRemaining, isOverdue, remainingMs } from '@/lib/cooking/timers';

import { useCookingTimers } from './timers-provider';

/**
 * The per-step way into the session's timer list.
 *
 * It no longer owns a countdown of its own. Tapping hands the step's duration
 * to the shared store, so the timer outlives the step: the previous version was
 * mounted with `key={currentStep}` and was therefore thrown away the moment the
 * cook moved on, which is the bug PHASE 6 exists to fix.
 *
 * While this step's timer is running the button becomes a read-only chip. A
 * second timer for the same step is still possible through the panel's add
 * form; what is prevented is starting a duplicate by tapping twice.
 */
export function StepTimer({ stepIndex, seconds }: { stepIndex: number; seconds: number }) {
  const { timers, now, start, canAdd } = useCookingTimers();

  const mine = timers.find(
    (timer) => timer.status === 'running' && timer.origin?.stepIndex === stepIndex,
  );

  if (mine) {
    const over = isOverdue(mine, now);
    return (
      <span
        className={cn(
          'inline-flex min-h-11 items-center rounded-lg border px-3 text-sm tabular-nums',
          over ? 'border-warn/40 bg-warn/10 text-warn' : 'border-line text-muted',
        )}
      >
        {over ? '時間です' : `計測中 ${formatRemaining(remainingMs(mine, now))}`}
      </span>
    );
  }

  return (
    <button
      type="button"
      disabled={!canAdd}
      onClick={() =>
        start({
          durationMs: seconds * 1000,
          origin: { stepIndex, label: `工程${stepIndex + 1}` },
        })
      }
      className="min-h-11 rounded-lg border border-accent/40 bg-accent/10 px-3 text-sm tabular-nums text-accent active:bg-accent/20 disabled:opacity-40"
    >
      タイマー {formatRemaining(seconds * 1000)}
    </button>
  );
}
