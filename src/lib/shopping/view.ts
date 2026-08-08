/**
 * Presentation rules for the shopping list.
 *
 * Kept out of the components so the parts worth testing — the split into
 * sections, the amount label, and above all the error wording — can be
 * exercised without a DOM.
 */

import { ZodError } from 'zod';

import { formatAmount } from '@/lib/recipes/units';
import type { ShoppingItem } from '@/types/domain';

/** The two sections of the screen, in the order the service already returned. */
export type ShoppingSections = {
  todo: ShoppingItem[];
  done: ShoppingItem[];
};

/**
 * Splits into to-buy and bought without re-sorting.
 *
 * `listShoppingItems` already orders by `checked asc, created_at asc`; sorting
 * again here would be a second, independent notion of order that could drift
 * from the index the query relies on.
 */
export function splitShoppingItems(items: readonly ShoppingItem[]): ShoppingSections {
  const todo: ShoppingItem[] = [];
  const done: ShoppingItem[] = [];

  for (const item of items) {
    if (item.checked) done.push(item);
    else todo.push(item);
  }

  return { todo, done };
}

/**
 * The amount chip's text, or '' when there is nothing to show.
 *
 * Reuses PHASE 8's formatter so 「1と1/2個」 and 「大さじ2」 read the same here
 * as they do in a recipe.
 */
export function shoppingAmountLabel(item: Pick<ShoppingItem, 'quantity' | 'unit'>): string {
  if (item.quantity === null && !item.unit) return '';
  return formatAmount(item.quantity, item.unit);
}

/**
 * What to say when the new line duplicates one already on the list.
 *
 * Phrased as a statement of what happened, not a question — the row is already
 * created, and nothing is waiting on the user to decide.
 */
export function duplicateNotice(name: string, duplicateCount: number): string | undefined {
  const trimmed = name.trim();
  if (duplicateCount <= 0 || trimmed === '') return undefined;

  return duplicateCount === 1
    ? `「${trimmed}」はすでにあります。別項目として追加しました`
    : `「${trimmed}」はすでに${duplicateCount}件あります。別項目として追加しました`;
}

/** Accessible name for a row's delete button — 「削除」 alone says which row? */
export function deleteLabel(name: string): string {
  return `${name.trim()}を削除`;
}

const GENERIC_ERROR = 'うまくいきませんでした。もう一度お試しください。';

/**
 * Turns any thrown value into something safe to render.
 *
 * Only our own zod messages are passed through. Everything else — a Postgres
 * error, a constraint name like `shopping_items_unit_needs_quantity`, a stack
 * — collapses to one generic sentence, because the alternative is putting
 * schema details on screen for a person holding a shopping basket. The
 * original is the caller's to log.
 */
export function describeShoppingError(error: unknown): string {
  if (error instanceof ZodError) {
    return error.issues[0]?.message ?? GENERIC_ERROR;
  }
  return GENERIC_ERROR;
}

/** What the caller should write to the server log, never to the screen. */
export function errorDetail(error: unknown): string {
  if (error instanceof ZodError) return error.issues.map((issue) => issue.message).join('; ');
  return error instanceof Error ? error.message : String(error);
}
