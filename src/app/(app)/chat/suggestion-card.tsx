'use client';

import Link from 'next/link';
import { useState, useTransition } from 'react';

import { Button } from '@/components/ui/button';
import { Chip } from '@/components/ui/surfaces';
import { cn } from '@/lib/cn';
import {
  allAdded,
  applyOutcome,
  canSubmit,
  initialCardState,
  isAdded,
  isBlocked,
  selectedNames,
  toggleSuggestion,
} from '@/lib/shopping/suggestion-card-state';
import type { ShoppingSuggestion } from '@/lib/shopping/suggest';

import { addSuggestedShoppingItemsAction } from '../shopping/actions';

/**
 * Shopping candidates the assistant worked out, for the user to pick from.
 *
 * The suggestion itself adds nothing — that is the whole point of the split.
 * This card is the only way a candidate becomes a line on the list, and it
 * takes a deliberate tick and a press to get there.
 *
 * The card outlives a single press: someone adds what they need for tonight,
 * then comes back for one more. So a finished press locks the lines it added
 * and leaves the rest alone. All the rules for that live in
 * `@/lib/shopping/suggestion-card-state`, where they can be tested.
 *
 * Deliberately not restored after a reload: the candidates are a reading of
 * the fridge at one moment, and showing an hour-old 「玉ねぎが無い」 would have
 * someone buy a second one.
 */
export function SuggestionCard({ suggestions }: { suggestions: ShoppingSuggestion[] }) {
  // Nothing is ticked to begin with. The user chooses what to buy; a card
  // that arrives pre-selected is deciding for them.
  const [state, setState] = useState(() => initialCardState(crypto.randomUUID()));
  const [pending, startTransition] = useTransition();

  if (suggestions.length === 0) return null;

  const names = suggestions.map((entry) => entry.name);
  const blocked = isBlocked(state, pending);
  const everythingAdded = allAdded(state, names);
  const outcome = state.outcome;

  function submit() {
    if (!canSubmit(state, names, pending)) return;

    const chosen = suggestions.filter((entry) => selectedNames(state).includes(entry.name));

    startTransition(async () => {
      const result = await addSuggestedShoppingItemsAction(
        state.requestId,
        chosen.map((entry) => ({
          name: entry.name,
          quantity: entry.quantity,
          unit: entry.unit,
        })),
      );

      // A fresh key is offered on every press; `applyOutcome` takes it only
      // when the press actually completed. Reusing a spent key replays the old
      // result; rotating an unspent one turns a retry into a second write.
      setState((current) => applyOutcome(current, result, crypto.randomUUID()));
    });
  }

  return (
    <div className="rounded-card border border-line bg-surface p-3">
      <p className="mb-2 px-1 text-sm font-semibold text-muted">買い物候補</p>

      <ul className={cn('space-y-1', pending && 'opacity-60')}>
        {suggestions.map((entry) => {
          const added = isAdded(state, entry.name);
          const checked = state.picked.has(entry.name);
          const amount = entry.quantity === null ? '' : `${entry.quantity}${entry.unit ?? ''}`;

          return (
            <li key={entry.name}>
              <label
                className={cn(
                  'flex min-h-14 items-center gap-3 rounded-xl px-2',
                  added || blocked ? 'cursor-default' : 'cursor-pointer',
                )}
              >
                <input
                  type="checkbox"
                  checked={added || checked}
                  // An added line stays ticked and locked, so a second press
                  // cannot send it again.
                  disabled={added || blocked}
                  onChange={() => setState((current) => toggleSuggestion(current, entry.name))}
                  className="size-6 shrink-0 accent-[var(--color-accent,currentColor)]"
                />
                <span className="min-w-0 flex-1">
                  <span className={cn('block break-words', added && 'text-faint')}>
                    {entry.name}
                  </span>
                  <span className="block text-xs text-faint">
                    {entry.reasonLabel}
                    {entry.sourceRecipes.length > 0
                      ? ` · ${entry.sourceRecipes.map((source) => source.title).join('、')}`
                      : ''}
                  </span>
                  {added ? (
                    <span className="mt-0.5 block text-xs text-ok">追加済み</span>
                  ) : entry.alreadyOnList ? (
                    /*
                     * A warning, never a veto. PHASE 9 settled this: 「卵 6個」
                     * and 「卵 1パック」 are both legitimate, so the user decides.
                     */
                    <span className="mt-0.5 block text-xs text-warn">
                      すでにリストにあります
                    </span>
                  ) : null}
                </span>
                {amount ? <Chip tone={checked && !added ? 'accent' : 'neutral'}>{amount}</Chip> : null}
              </label>
            </li>
          );
        })}
      </ul>

      {outcome?.status === 'unknown' ? (
        /*
         * Rows may or may not exist and we cannot tell. Offering a retry here
         * is exactly how the same items get added twice, so the only way on is
         * to go and look. This is the one outcome that closes the card.
         */
        <div className="mt-2 space-y-1 px-1">
          <p role="alert" className="text-sm text-danger">
            {outcome.message}
          </p>
          <Link href="/shopping" className="inline-block text-xs text-accent">
            買い物リストを見る
          </Link>
        </div>
      ) : (
        <>
          {outcome?.status === 'done' ? (
            <div className="mt-2 space-y-1 px-1">
              <p className="text-sm text-fg">
                {outcome.added.length}件を買い物リストに追加しました
                {outcome.failed.length > 0
                  ? `（${outcome.failed.length}件は失敗しました）`
                  : ''}
              </p>
              {outcome.notices.map((notice) => (
                <p key={notice} className="text-xs text-warn">
                  {notice}
                </p>
              ))}
              {outcome.failed.map((failure) => (
                <p key={failure.name} className="text-xs text-danger">
                  {failure.name}: {failure.message}
                </p>
              ))}
              <Link href="/shopping" className="inline-block text-xs text-accent">
                買い物リストを見る
              </Link>
            </div>
          ) : null}

          {/* Only once there is nothing left to add does the button go away. */}
          {everythingAdded ? null : (
            <Button
              variant="primary"
              size="md"
              block
              className="mt-2"
              disabled={!canSubmit(state, names, pending)}
              aria-disabled={!canSubmit(state, names, pending)}
              onClick={submit}
            >
              {pending ? '追加中…' : `選んだ${state.picked.size}件を買い物リストに追加`}
            </Button>
          )}

          {outcome && outcome.status !== 'done' ? (
            <p role="alert" className="mt-2 px-1 text-sm text-danger">
              {outcome.message}
            </p>
          ) : null}
        </>
      )}

      <p aria-live="polite" className="sr-only">
        {outcome === null
          ? ''
          : outcome.status === 'done'
            ? `${outcome.added.length}件を買い物リストに追加しました`
            : outcome.message}
      </p>
    </div>
  );
}
