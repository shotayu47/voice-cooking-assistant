'use client';

import { useState, useTransition } from 'react';

import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/surfaces';
import { splitShoppingItems } from '@/lib/shopping/view';
import type { ShoppingItem } from '@/types/domain';

import { clearCheckedShoppingItemsAction } from './actions';
import { ShoppingRow } from './shopping-row';

/**
 * The two sections of the list.
 *
 * Bought lines stay on screen rather than disappearing: mid-shop, 「これ買った
 * っけ」 is the question the list has to answer, and an immediate delete makes
 * a mistap unrecoverable. Clearing them is a separate, deliberate action.
 */
export function ShoppingList({ items }: { items: ShoppingItem[] }) {
  const { todo, done } = splitShoppingItems(items);
  const [showDone, setShowDone] = useState(false);
  const [clearing, startClearing] = useTransition();
  const [error, setError] = useState<string | null>(null);

  if (items.length === 0) {
    return (
      <EmptyState
        title="買うものはまだありません"
        hint="品名だけで追加できます。「牛乳」だけでも大丈夫です。"
      />
    );
  }

  return (
    <div className="space-y-6">
      <section>
        <h2 className="mb-2 px-1 text-sm font-semibold text-muted">
          買うもの
          <span className="ml-2 text-faint">{todo.length}</span>
        </h2>

        {todo.length === 0 ? (
          <p className="rounded-card border border-dashed border-line px-4 py-6 text-center text-sm text-muted">
            買うものはすべて買いました
          </p>
        ) : (
          <ul className="overflow-hidden rounded-card border border-line">
            {todo.map((item) => (
              <li key={item.id} className="border-b border-line last:border-b-0">
                <ShoppingRow item={item} />
              </li>
            ))}
          </ul>
        )}
      </section>

      {done.length > 0 ? (
        <section>
          <button
            type="button"
            onClick={() => setShowDone((open) => !open)}
            aria-expanded={showDone}
            className="mb-2 flex min-h-11 w-full items-center gap-2 px-1 text-sm font-semibold text-muted"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className={showDone ? 'rotate-90 transition-transform' : 'transition-transform'}
              aria-hidden
            >
              <path d="M9 5l7 7-7 7" />
            </svg>
            買ったもの
            <span className="text-faint">{done.length}</span>
          </button>

          {showDone ? (
            <>
              <ul className="overflow-hidden rounded-card border border-line">
                {done.map((item) => (
                  <li key={item.id} className="border-b border-line last:border-b-0">
                    <ShoppingRow item={item} />
                  </li>
                ))}
              </ul>

              <Button
                variant="danger"
                size="md"
                block
                className="mt-3"
                disabled={clearing}
                aria-disabled={clearing}
                onClick={() => {
                  setError(null);
                  startClearing(async () => {
                    const result = await clearCheckedShoppingItemsAction();
                    if (result.status === 'error') setError(result.message);
                  });
                }}
              >
                {clearing ? '削除中…' : `買ったもの${done.length}件を削除`}
              </Button>

              {error ? (
                <p role="alert" className="mt-2 text-sm text-danger">
                  {error}
                </p>
              ) : null}
            </>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
