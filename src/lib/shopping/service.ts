import 'server-only';

import { normalizeIngredientName } from '@/lib/inventory/normalize';
import { ServiceError, type ServiceContext } from '@/lib/inventory/service';
import { timed } from '@/lib/perf';
import type { ShoppingItem } from '@/types/domain';

import { findDuplicates } from './dedupe';
import {
  createShoppingItemSchema,
  deleteShoppingItemSchema,
  setShoppingItemCheckedSchema,
  type CreateShoppingItemInput,
} from './schemas';

/**
 * Shopping list data access.
 *
 * Every statement filters on `user_id` explicitly. RLS enforces the same rule
 * in the database and is the boundary that actually holds, but a bulk delete
 * that leans on RLS alone is one misconfigured policy away from clearing other
 * people's lists — so the condition is written twice, on purpose.
 */

const ITEM_COLUMNS = '*';

export async function listShoppingItems(ctx: ServiceContext): Promise<ShoppingItem[]> {
  // To-buy first, then oldest first — the order the list index was built for.
  const query = ctx.supabase
    .from('shopping_items')
    .select(ITEM_COLUMNS)
    .eq('user_id', ctx.userId)
    .order('checked', { ascending: true })
    .order('created_at', { ascending: true });

  const { data, error } = await timed('db:listShoppingItems', async () => query);
  if (error) throw new ServiceError(error.message);
  return (data ?? []) as ShoppingItem[];
}

/**
 * What `createShoppingItem` returns.
 *
 * `duplicates` is information, not a failure — the row is always created. It
 * lets the UI say 「『卵』はすでにあります。別項目として追加しました」 without
 * the service having decided anything on the user's behalf.
 */
export type CreateShoppingItemResult = {
  item: ShoppingItem;
  duplicates: ShoppingItem[];
};

export async function createShoppingItem(
  ctx: ServiceContext,
  input: CreateShoppingItemInput,
): Promise<CreateShoppingItemResult> {
  const parsed = createShoppingItemSchema.parse(input);

  const normalized = normalizeIngredientName(parsed.name);
  if (normalized.trim() === '') {
    // Reachable when a name is punctuation the folding rules strip entirely.
    // The database CHECK would refuse it; failing here keeps the message
    // in Japanese and in the same shape as the other validation errors.
    throw new ServiceError('品名を入力してください');
  }

  // Read before insert so the new row is not compared against itself.
  const existing = await listShoppingItems(ctx);
  const duplicates = findDuplicates(parsed.name, existing);

  const { data, error } = await ctx.supabase
    .from('shopping_items')
    .insert({
      user_id: ctx.userId,
      name: parsed.name,
      normalized_name: normalized,
      quantity: parsed.quantity ?? null,
      unit: parsed.unit ?? null,
      checked: false,
      checked_at: null,
    })
    .select(ITEM_COLUMNS)
    .single();

  if (error) throw new ServiceError(error.message);
  return { item: data as ShoppingItem, duplicates };
}

/**
 * Tick or untick one line.
 *
 * `checked_at` is written in the same statement as `checked` so the two can
 * never drift apart; the database CHECK refuses the combination anyway.
 * Returns null when nothing matched — a row already deleted on another device
 * is not an error worth throwing at someone mid-shop.
 */
export async function setShoppingItemChecked(
  ctx: ServiceContext,
  itemId: string,
  checked: boolean,
): Promise<ShoppingItem | null> {
  const parsed = setShoppingItemCheckedSchema.parse({ item_id: itemId, checked });

  const { data, error } = await ctx.supabase
    .from('shopping_items')
    .update({
      checked: parsed.checked,
      checked_at: parsed.checked ? new Date().toISOString() : null,
    })
    .eq('user_id', ctx.userId)
    .eq('id', parsed.item_id)
    .select(ITEM_COLUMNS);

  if (error) throw new ServiceError(error.message);
  return ((data ?? [])[0] as ShoppingItem | undefined) ?? null;
}

/**
 * Remove one line. Deleting a row that is already gone is a no-op, not a
 * failure — double taps happen, and the second one has nothing left to do.
 */
export async function deleteShoppingItem(
  ctx: ServiceContext,
  itemId: string,
): Promise<{ deleted: number }> {
  const parsed = deleteShoppingItemSchema.parse({ item_id: itemId });

  const { data, error } = await ctx.supabase
    .from('shopping_items')
    .delete()
    .eq('user_id', ctx.userId)
    .eq('id', parsed.item_id)
    .select('id');

  if (error) throw new ServiceError(error.message);
  return { deleted: (data ?? []).length };
}

/**
 * Clear the bought lines after a shop.
 *
 * The `user_id` filter is the important one here: without it this statement
 * would empty every user's checked items the moment RLS was misconfigured.
 * Unchecked lines are left alone — that is the whole point of the operation.
 */
export async function clearCheckedShoppingItems(
  ctx: ServiceContext,
): Promise<{ deleted: number }> {
  const { data, error } = await ctx.supabase
    .from('shopping_items')
    .delete()
    .eq('user_id', ctx.userId)
    .eq('checked', true)
    .select('id');

  if (error) throw new ServiceError(error.message);
  return { deleted: (data ?? []).length };
}
