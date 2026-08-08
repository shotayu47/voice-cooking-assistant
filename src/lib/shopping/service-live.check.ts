import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, describe, expect, it } from 'vitest';

import type { ServiceContext } from '@/lib/inventory/service';

import {
  clearCheckedShoppingItems,
  createShoppingItem,
  deleteShoppingItem,
  listShoppingItems,
  setShoppingItemChecked,
} from './service';

/**
 * The shopping service against real Postgres (not part of `npm test`).
 *
 * `fake-supabase` proves the service's own logic, but it does not enforce the
 * CHECK constraints migration 0005 adds. The pairing of `checked` and
 * `checked_at`, the refusal of a unit with no quantity, and the positive-only
 * quantity all live in the database — and the UI cannot be exercised in the
 * headless preview pane, which never hydrates. This closes that gap.
 *
 * Uses its own throwaway user, so no real list is touched, and removes both
 * the rows and the user afterwards.
 *
 * Run with: npm run test:live
 */

const URL_ENV = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

const EMAIL = 'shopping-live-check@example.com';

let userId = '';
let admin: SupabaseClient | null = null;

async function signIn(): Promise<ServiceContext> {
  admin = createClient(URL_ENV!, SERVICE_KEY!, { auth: { persistSession: false } });

  const link = await fetch(`${URL_ENV}/auth/v1/admin/generate_link`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_KEY!,
      authorization: `Bearer ${SERVICE_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ type: 'magiclink', email: EMAIL }),
  }).then((response) => response.json());

  const anon = createClient(URL_ENV!, ANON_KEY!, { auth: { persistSession: false } });
  const { data, error } = await anon.auth.verifyOtp({
    type: 'email',
    token_hash: link.hashed_token,
  });
  if (error || !data.user) throw new Error('could not sign the check user in');

  userId = data.user.id;
  return { supabase: anon, userId };
}

afterAll(async () => {
  if (!admin || !userId) return;
  await admin.from('shopping_items').delete().eq('user_id', userId);
  await admin.auth.admin.deleteUser(userId);
});

describe('shopping service against the real schema', () => {
  it('runs the whole list lifecycle end to end', async () => {
    expect(URL_ENV, 'NEXT_PUBLIC_SUPABASE_URL must be set').toBeTruthy();
    expect(SERVICE_KEY, 'SUPABASE_SERVICE_ROLE_KEY must be set').toBeTruthy();
    expect(ANON_KEY, 'anon/publishable key must be set').toBeTruthy();

    const ctx = await signIn();

    // Create — name only, which is the common case.
    const milk = await createShoppingItem(ctx, { name: '牛乳' });
    expect(milk.item.user_id).toBe(userId);
    expect(milk.item.normalized_name).toBe('牛乳');
    expect(milk.item.quantity).toBeNull();
    expect(milk.item.checked).toBe(false);
    expect(milk.duplicates).toEqual([]);

    // Create — with an amount.
    const eggs = await createShoppingItem(ctx, { name: '卵', quantity: 6, unit: '個' });
    expect(eggs.item.quantity).toBe(6);
    expect(eggs.item.unit).toBe('個');

    // A different spelling of the same thing is reported, never merged.
    const alias = await createShoppingItem(ctx, { name: 'たまご' });
    expect(alias.duplicates.map((d) => d.id)).toEqual([eggs.item.id]);
    expect(alias.item.id).not.toBe(eggs.item.id);
    expect(alias.item.normalized_name).toBe('卵');

    // Order: unchecked first, oldest first.
    expect((await listShoppingItems(ctx)).map((row) => row.name)).toEqual(['牛乳', '卵', 'たまご']);

    // Tick — `checked_at` must land with it or the CHECK constraint refuses.
    const ticked = await setShoppingItemChecked(ctx, milk.item.id, true);
    expect(ticked?.checked).toBe(true);
    expect(ticked?.checked_at).not.toBeNull();

    // A ticked line sorts below the rest.
    expect((await listShoppingItems(ctx)).map((row) => row.name)).toEqual(['卵', 'たまご', '牛乳']);

    // Untick — and `checked_at` must clear, or the same constraint refuses.
    const unticked = await setShoppingItemChecked(ctx, milk.item.id, false);
    expect(unticked?.checked).toBe(false);
    expect(unticked?.checked_at).toBeNull();

    // Delete one line, twice — the second is a no-op, not an error.
    expect(await deleteShoppingItem(ctx, alias.item.id)).toEqual({ deleted: 1 });
    expect(await deleteShoppingItem(ctx, alias.item.id)).toEqual({ deleted: 0 });

    // Clear only what is ticked.
    await setShoppingItemChecked(ctx, eggs.item.id, true);
    expect(await clearCheckedShoppingItems(ctx)).toEqual({ deleted: 1 });

    const left = await listShoppingItems(ctx);
    expect(left.map((row) => row.name)).toEqual(['牛乳']);
  });

  it('lets the database refuse what the schema forbids', async () => {
    const ctx: ServiceContext = {
      supabase: createClient(URL_ENV!, SERVICE_KEY!, { auth: { persistSession: false } }),
      userId,
    };

    // Bypasses the zod layer on purpose: this is the database's answer, not
    // the application's, and it is the one that holds if validation is ever
    // skipped by a future caller.
    const unitWithoutQuantity = await ctx.supabase
      .from('shopping_items')
      .insert({ user_id: userId, name: 'g だけ', normalized_name: 'gだけ', unit: 'g' });
    expect(unitWithoutQuantity.error?.message).toContain('shopping_items_unit_needs_quantity');

    const zeroQuantity = await ctx.supabase
      .from('shopping_items')
      .insert({ user_id: userId, name: 'ゼロ', normalized_name: 'ぜろ', quantity: 0 });
    expect(zeroQuantity.error?.message).toContain('shopping_items_quantity_positive');

    const checkedWithoutTimestamp = await ctx.supabase
      .from('shopping_items')
      .insert({ user_id: userId, name: '済', normalized_name: '済', checked: true });
    expect(checkedWithoutTimestamp.error?.message).toContain(
      'shopping_items_checked_at_matches_checked',
    );

    const blankName = await ctx.supabase
      .from('shopping_items')
      .insert({ user_id: userId, name: '   ', normalized_name: 'x' });
    expect(blankName.error?.message).toContain('shopping_items_name_not_blank');
  });
});
