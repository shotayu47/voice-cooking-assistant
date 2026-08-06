'use client';

import { useEffect, useRef, useState } from 'react';

import { cn } from '@/lib/cn';

/**
 * A one-shot countdown for the current step. Deliberately not persisted: a
 * timer that survives a reload but kept running while the phone was locked
 * would be misleading about how long the pan has actually been on.
 */
export function StepTimer({ seconds }: { seconds: number }) {
  const [remaining, setRemaining] = useState(seconds);
  const [running, setRunning] = useState(false);
  const deadlineRef = useRef<number | null>(null);

  useEffect(() => {
    if (!running) return;

    deadlineRef.current = Date.now() + remaining * 1000;
    const id = setInterval(() => {
      const left = Math.max(0, Math.round((deadlineRef.current! - Date.now()) / 1000));
      setRemaining(left);
      if (left === 0) setRunning(false);
    }, 250);

    return () => clearInterval(id);
    // `remaining` is intentionally read once when the timer starts; including
    // it here would reset the deadline on every tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running]);

  const done = remaining === 0;

  return (
    <button
      type="button"
      onClick={() => {
        if (done) {
          setRemaining(seconds);
          setRunning(true);
        } else {
          setRunning((value) => !value);
        }
      }}
      className={cn(
        'min-h-11 rounded-lg border px-3 text-sm tabular-nums',
        done
          ? 'border-ok/40 bg-ok/10 text-ok'
          : running
            ? 'border-accent/40 bg-accent/10 text-accent'
            : 'border-line text-fg',
      )}
    >
      {done ? '時間です — もう一度' : `${running ? '停止' : 'タイマー'} ${format(remaining)}`}
    </button>
  );
}

function format(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}
