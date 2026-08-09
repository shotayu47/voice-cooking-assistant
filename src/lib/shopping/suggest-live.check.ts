import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, describe, expect, it } from 'vitest';

import type { ServiceContext } from '@/lib/inventory/service';
import { IdempotencyUnavailableError, runOnce } from '@/lib/ai/idempotency';

import { runAddSuggested, type ShoppingDeps } from './actions-core';
import { createShoppingItem, listShoppingItems } from './service';

/**
 * The confirmation path against real Postgres (not part of `npm test`).
 *
 * The claim is that PHASE 10 needs no migration because `ai_tool_calls` can
 * hold a UI-supplied request key. `fake-supabase` models the unique index, but
 * only the real database proves the upsert-as-claim behaves the same way under
 * RLS with a key that never came from a model. That is what this checks.
 *
 * Uses a throwaway user and removes it, and its rows, afterwards.
 *
 * Run with: npm run test:live
 */

const URL_ENV = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

const EMAIL = 'suggest-live-check@example.com';

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

function depsFor(ctx: ServiceContext): ShoppingDeps {
  return {
    create: (input) => createShoppingItem(ctx, input),
    setChecked: async () => null,
    remove: async () => ({ deleted: 0 }),
    clearChecked: async () => ({ deleted: 0 }),
    // The real action calls revalidatePath; here it only needs to not explode.
    revalidate: () => {},
  };
}

afterAll(async () => {
  if (!admin || !userId) return;
  await admin.from('shopping_items').delete().eq('user_id', userId);
  await admin.from('ai_tool_calls').delete().eq('user_id', userId);
  await admin.auth.admin.deleteUser(userId);
});

describe('confirming suggestions against the real ledger', () => {
  it('adds once, and a resubmit with the same key adds nothing', async () => {
    expect(URL_ENV, 'NEXT_PUBLIC_SUPABASE_URL must be set').toBeTruthy();
    expect(SERVICE_KEY, 'SUPABASE_SERVICE_ROLE_KEY must be set').toBeTruthy();
    expect(ANON_KEY, 'anon/publishable key must be set').toBeTruthy();

    const ctx = await signIn();
    const deps = depsFor(ctx);
    const picked = [
      { name: 'じゃが芋', quantity: 2, unit: '個' },
      { name: '玉ねぎ', quantity: null, unit: null },
    ];

    // A UI-generated key, not a model call id — the reuse this phase depends on.
    const requestId = `req-${userId}-1`;

    const first = await runOnce(
      ctx,
      requestId,
      'add_suggested_shopping_items',
      () => runAddSuggested(deps, picked),
      { failClosed: true },
    );

    expect(first.duplicate).toBe(false);
    expect((first.value as { added: string[] }).added).toEqual(['じゃが芋', '玉ねぎ']);
    expect(await listShoppingItems(ctx)).toHaveLength(2);

    const second = await runOnce(
      ctx,
      requestId,
      'add_suggested_shopping_items',
      () => runAddSuggested(deps, picked),
      { failClosed: true },
    );

    // The ledger answered instead of running: still two rows, not four.
    expect(second.duplicate).toBe(true);
    expect(await listShoppingItems(ctx)).toHaveLength(2);
  });

  it('two simultaneous submits of the same key add one set', async () => {
    const ctx: ServiceContext = {
      supabase: createClient(URL_ENV!, ANON_KEY!, { auth: { persistSession: false } }),
      userId,
    };
    // Sign the same user in again for a fresh client.
    const signedIn = await signIn();
    const deps = depsFor(signedIn);
    void ctx;

    const requestId = `req-${userId}-race`;
    const picked = [{ name: '人参', quantity: null, unit: null }];

    const [a, b] = await Promise.all([
      runOnce(signedIn, requestId, 'add_suggested_shopping_items', () => runAddSuggested(deps, picked), {
        failClosed: true,
      }),
      runOnce(signedIn, requestId, 'add_suggested_shopping_items', () => runAddSuggested(deps, picked), {
        failClosed: true,
      }),
    ]);

    // Exactly one of them executed.
    expect([a.duplicate, b.duplicate].filter(Boolean)).toHaveLength(1);

    const carrots = (await listShoppingItems(signedIn)).filter((row) => row.name === '人参');
    expect(carrots).toHaveLength(1);
  });

  it('refuses to run at all when no key is supplied', async () => {
    const signedIn = await signIn();

    await expect(
      runOnce(
        signedIn,
        null,
        'add_suggested_shopping_items',
        () => runAddSuggested(depsFor(signedIn), [{ name: '絶対に追加されない', quantity: null, unit: null }]),
        { failClosed: true },
      ),
    ).rejects.toBeInstanceOf(IdempotencyUnavailableError);

    const rows = await listShoppingItems(signedIn);
    expect(rows.map((row) => row.name)).not.toContain('絶対に追加されない');
  });
});
