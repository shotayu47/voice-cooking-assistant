'use client';

import Link from 'next/link';
import { useState, useTransition } from 'react';

import { Chip } from '@/components/ui/surfaces';
import { cn } from '@/lib/cn';
import { FreshnessText } from '@/components/ui/freshness-badge';
import { freshnessOf } from '@/lib/inventory/freshness';
import { QUANTITY_STATE_LABELS, STORAGE_LABELS } from '@/lib/labels';
import type { InventoryItem, QuantityState, StorageLocation } from '@/types/domain';

import { adjustQuantityAction, setStateAction } from './actions';

const STATE_TONE: Record<QuantityState, 'neutral' | 'ok' | 'warn' | 'danger'> = {
  unknown: 'neutral',
  low: 'warn',
  available: 'ok',
  plenty: 'ok',
  empty: 'danger',
};

export function InventoryRow({ item }: { item: InventoryItem }) {
  const [expanded, setExpanded] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const empty = item.quantity_state === 'empty';
  const freshness = freshnessOf(item);

  function run(action: () => Promise<{ status: string; reason?: string }>) {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (result.status === 'needs_clarification') {
        setError(result.reason ?? '変更できませんでした');
      }
    });
  }

  return (
    <div className={cn('bg-surface', pending && 'opacity-60')}>
      <div className="flex items-stretch">
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          className="flex min-h-[60px] flex-1 items-center gap-3 px-4 py-2 text-left active:bg-surface-2"
        >
          <span className="min-w-0 flex-1">
            <span className={cn('block truncate', empty && 'text-faint line-through')}>
              {item.name}
            </span>
            <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-faint">
              {item.quantity !== null ? (
                <span className="text-muted">
                  {item.quantity}
                  {item.unit ?? ''}
                </span>
              ) : null}
              {item.storage_location ? (
                <span>{STORAGE_LABELS[item.storage_location as StorageLocation]}</span>
              ) : null}
              {freshness ? <FreshnessText freshness={freshness} /> : null}
            </span>
          </span>

          <Chip tone={STATE_TONE[item.quantity_state]}>
            {QUANTITY_STATE_LABELS[item.quantity_state]}
          </Chip>
        </button>

        <Link
          href={`/inventory/${item.id}`}
          aria-label={`${item.name} を編集`}
          className="flex w-12 items-center justify-center border-l border-line text-faint active:bg-surface-2"
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M9 5l7 7-7 7" />
          </svg>
        </Link>
      </div>

      {expanded ? (
        <div className="space-y-2 border-t border-line bg-bg px-3 py-3">
          <div className="flex gap-2">
            <QuickButton
              label="−1"
              disabled={pending}
              onClick={() => run(() => adjustQuantityAction(item.id, -1))}
            />
            <QuickButton
              label="+1"
              disabled={pending}
              onClick={() => run(() => adjustQuantityAction(item.id, 1))}
            />
          </div>
          <div className="flex gap-2">
            <QuickButton
              label="少ない"
              disabled={pending}
              onClick={() => run(() => setStateAction(item.id, 'low'))}
            />
            <QuickButton
              label="十分ある"
              disabled={pending}
              onClick={() => run(() => setStateAction(item.id, 'plenty'))}
            />
            <QuickButton
              label="使い切った"
              tone="danger"
              disabled={pending}
              onClick={() => run(() => setStateAction(item.id, 'empty'))}
            />
          </div>
          {error ? <p className="text-xs text-danger">{error}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

function QuickButton({
  label,
  onClick,
  disabled,
  tone = 'neutral',
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  tone?: 'neutral' | 'danger';
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'min-h-11 flex-1 rounded-lg border text-sm active:bg-surface-2 disabled:opacity-40',
        tone === 'danger'
          ? 'border-danger/40 text-danger'
          : 'border-line text-fg',
      )}
    >
      {label}
    </button>
  );
}

