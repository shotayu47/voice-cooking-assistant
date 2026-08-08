'use client';

import { useId, useState, useTransition } from 'react';

import { Chip } from '@/components/ui/surfaces';
import { cn } from '@/lib/cn';
import { deleteLabel, shoppingAmountLabel } from '@/lib/shopping/view';
import type { MutationOutcome } from '@/lib/shopping/actions-core';
import type { ShoppingItem } from '@/types/domain';

import { deleteShoppingItemAction, setShoppingItemCheckedAction } from './actions';

/**
 * One line on the list.
 *
 * The tick area is a `<label>` bound to a real checkbox and the delete button
 * is its sibling — never nested inside it. A button inside a button (or inside
 * a label) is invalid, and on iOS the outer control swallows the inner tap, so
 * "delete" would toggle the line instead of removing it.
 */
export function ShoppingRow({ item }: { item: ShoppingItem }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const checkboxId = useId();
  const errorId = useId();

  const amount = shoppingAmountLabel(item);

  function run(action: () => Promise<MutationOutcome>) {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (result.status === 'error') setError(result.message);
    });
  }

  return (
    <div className={cn('bg-surface', pending && 'opacity-60')}>
      <div className="flex items-stretch">
        <label
          htmlFor={checkboxId}
          className="flex min-h-14 flex-1 cursor-pointer items-center gap-3 py-2 pl-3 pr-2"
        >
          <input
            id={checkboxId}
            type="checkbox"
            checked={item.checked}
            disabled={pending}
            aria-describedby={error ? errorId : undefined}
            onChange={(event) => {
              const next = event.target.checked;
              run(() => setShoppingItemCheckedAction(item.id, next));
            }}
            className="size-6 shrink-0 accent-[var(--color-accent,currentColor)]"
          />
          <span
            className={cn(
              'min-w-0 flex-1 break-words',
              item.checked && 'text-faint line-through',
            )}
          >
            {item.name}
          </span>
          {amount ? (
            <Chip tone={item.checked ? 'neutral' : 'accent'}>{amount}</Chip>
          ) : null}
        </label>

        <button
          type="button"
          aria-label={deleteLabel(item.name)}
          disabled={pending}
          aria-disabled={pending}
          onClick={() => run(() => deleteShoppingItemAction(item.id))}
          className="flex min-h-14 w-12 shrink-0 items-center justify-center text-faint active:bg-surface-2 disabled:opacity-40"
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
            <path d="M4 7h16" />
            <path d="M9 7V4h6v3" />
            <path d="M6 7l1 13h10l1-13" />
          </svg>
        </button>
      </div>

      {error ? (
        <p id={errorId} role="alert" className="px-3 pb-2 text-sm text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
