'use client';

import Link from 'next/link';
import { useRef, useState, useTransition } from 'react';

import { Button } from '@/components/ui/button';
import { Chip } from '@/components/ui/surfaces';
import { cn } from '@/lib/cn';
import type { AddSuggestedResult } from '@/lib/shopping/actions-core';
import type { ShoppingSuggestion } from '@/lib/shopping/suggest';

import { addSuggestedShoppingItemsAction } from '../shopping/actions';

/**
 * Shopping candidates the assistant worked out, for the user to pick from.
 *
 * The suggestion itself adds nothing — that is the whole point of the split.
 * This card is the only way a candidate becomes a line on the list, and it
 * takes a deliberate tick and a press to get there.
 *
 * Deliberately not restored after a reload: the candidates are a reading of
 * the fridge at one moment, and showing an hour-old 「玉ねぎが無い」 would have
 * someone buy a second one.
 */
export function SuggestionCard({ suggestions }: { suggestions: ShoppingSuggestion[] }) {
  // Nothing is ticked to begin with. The user chooses what to buy; a card
  // that arrives pre-selected is deciding for them.
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [result, setResult] = useState<AddSuggestedResult | null>(null);
  const [pending, startTransition] = useTransition();

  /*
   * One key for this card, held until the run finishes. A double tap — or a
   * resubmit after a dropped connection — arrives with the same key, and the
   * server answers from its ledger instead of adding a second time. Generated
   * once per card rather than per press, so the retry really is the same
   * request rather than a new one.
   */
  const requestId = useRef<string>(crypto.randomUUID());

  if (suggestions.length === 0) return null;

  const done = result !== null && result.added.length > 0;

  function toggle(name: string) {
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  function submit() {
    const chosen = suggestions.filter((entry) => picked.has(entry.name));
    if (chosen.length === 0 || pending) return;

    startTransition(async () => {
      const outcome = await addSuggestedShoppingItemsAction(
        requestId.current,
        chosen.map((entry) => ({
          name: entry.name,
          quantity: entry.quantity,
          unit: entry.unit,
        })),
      );
      setResult(outcome);
    });
  }

  return (
    <div className="rounded-card border border-line bg-surface p-3">
      <p className="mb-2 px-1 text-sm font-semibold text-muted">買い物候補</p>

      <ul className={cn('space-y-1', pending && 'opacity-60')}>
        {suggestions.map((entry) => {
          const checked = picked.has(entry.name);
          const amount = entry.quantity === null ? '' : `${entry.quantity}${entry.unit ?? ''}`;

          return (
            <li key={entry.name}>
              <label className="flex min-h-14 cursor-pointer items-center gap-3 rounded-xl px-2">
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={pending || done}
                  onChange={() => toggle(entry.name)}
                  className="size-6 shrink-0 accent-[var(--color-accent,currentColor)]"
                />
                <span className="min-w-0 flex-1">
                  <span className="block break-words">{entry.name}</span>
                  <span className="block text-xs text-faint">
                    {entry.reasonLabel}
                    {entry.sourceRecipes.length > 0
                      ? ` · ${entry.sourceRecipes.map((source) => source.title).join('、')}`
                      : ''}
                  </span>
                  {/*
                   * A warning, never a veto. PHASE 9 settled this: 「卵 6個」 and
                   * 「卵 1パック」 are both legitimate, so the user decides.
                   */}
                  {entry.alreadyOnList ? (
                    <span className="mt-0.5 block text-xs text-warn">
                      すでにリストにあります
                    </span>
                  ) : null}
                </span>
                {amount ? <Chip tone={checked ? 'accent' : 'neutral'}>{amount}</Chip> : null}
              </label>
            </li>
          );
        })}
      </ul>

      {done ? (
        <div className="mt-2 space-y-1 px-1">
          <p className="text-sm text-fg">
            {result.added.length}件を買い物リストに追加しました
            {result.failed.length > 0 ? `（${result.failed.length}件は失敗しました）` : ''}
          </p>
          {result.notices.map((notice) => (
            <p key={notice} className="text-xs text-warn">
              {notice}
            </p>
          ))}
          {result.failed.map((failure) => (
            <p key={failure.name} className="text-xs text-danger">
              {failure.name}: {failure.message}
            </p>
          ))}
          <Link href="/shopping" className="inline-block text-xs text-accent">
            買い物リストを見る
          </Link>
        </div>
      ) : (
        <>
          <Button
            variant="primary"
            size="md"
            block
            className="mt-2"
            disabled={pending || picked.size === 0}
            aria-disabled={pending || picked.size === 0}
            onClick={submit}
          >
            {pending ? '追加中…' : `選んだ${picked.size}件を買い物リストに追加`}
          </Button>

          {result?.error ? (
            <p role="alert" className="mt-2 px-1 text-sm text-danger">
              {result.error}
            </p>
          ) : null}
        </>
      )}

      <p aria-live="polite" className="sr-only">
        {done
          ? `${result.added.length}件を買い物リストに追加しました`
          : (result?.error ?? '')}
      </p>
    </div>
  );
}
