import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ServiceContext } from '@/lib/inventory/service';

import { getOrCreateConversation } from './service';

/**
 * The one-active-conversation rule against real Postgres (not part of `npm test`).
 *
 * `fake-supabase` can be told to reject a second active row, but it is the
 * thing being told — it proves `getOrCreateConversation` handles a 23505, not
 * that Postgres will ever raise one. Only the real partial unique index from
 * migration `0006_one_active_conversation.sql` decides that, and the race it
 * guards is between two processes, so no unit test can reach it.
 *
 * **Run only after 0006 has been applied.** Before that the index does not
 * exist, both tests below fail, and the failure messages say so.
 *
 * Uses its own throwaway user, so no real conversation is read or touched.
 * Cleanup deletes that user; `conversation_sessions.user_id` and
 * `conversation_messages.user_id` both reference `auth.users(id)`
 * `on delete cascade`, so the rows go with it. Nothing is deleted by hand.
 *
 * Run with: npm run test:live
 */

const URL_ENV = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

const EMAIL = 'conversation-live-check@example.com';

const NOT_APPLIED =
  'migration 0006_one_active_conversation.sql が未適用の可能性があります。' +
  'docs/phase10-ai-shopping-suggestions.md §12 を参照してください';

/** Round trips to Auth and Postgres do not fit in Vitest's 5s default. */
const TIMEOUT = 30_000;

let userId = '';
let admin: SupabaseClient | null = null;
let ctx: ServiceContext | null = null;
let conversationId = '';

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

beforeAll(async () => {
  if (!URL_ENV || !SERVICE_KEY || !ANON_KEY) {
    throw new Error(
      'NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / anon key must be set in .env.local',
    );
  }
  // Signing in is a network round trip that has nothing to do with what any
  // one test asserts. Paying for it here keeps it out of their time budget —
  // and a failure here reads as "could not sign in" rather than as the first
  // test mysteriously timing out.
  ctx = await signIn();
}, TIMEOUT);

afterAll(async () => {
  // Deleting the user is the whole cleanup: the cascade takes the throwaway
  // conversation and its messages with it. No row is removed by name.
  //
  // The id is looked up by email when sign-in never got far enough to record
  // one. A check that creates an account has to remove it even on the paths
  // where it fails, or a failed run leaves the account behind — which is
  // exactly what happened the first time this file was run.
  if (!URL_ENV || !SERVICE_KEY) return;
  admin ??= createClient(URL_ENV, SERVICE_KEY, { auth: { persistSession: false } });

  let id = userId;
  if (!id) {
    const { data } = await admin.auth.admin.listUsers();
    id = data?.users.find((user) => user.email === EMAIL)?.id ?? '';
  }

  if (id) await admin.auth.admin.deleteUser(id);
}, TIMEOUT);

describe('one active conversation per user, against the real index', () => {
  it('gives two simultaneous callers the same conversation', async () => {
    // The user starts with nothing, so both calls take the insert path. This
    // is the shape of the real race: a page render and a POST /api/chat that
    // arrive together, each reading zero active conversations.
    const [first, second] = await Promise.all([
      getOrCreateConversation(ctx!),
      getOrCreateConversation(ctx!),
    ]);

    expect(first, NOT_APPLIED).toBe(second);
    conversationId = first;

    const { data, error } = await admin!
      .from('conversation_sessions')
      .select('id')
      .eq('user_id', userId)
      .eq('status', 'active');

    expect(error).toBeNull();
    expect(data, NOT_APPLIED).toHaveLength(1);
    expect(data![0].id).toBe(first);
  }, TIMEOUT);

  it('lets the database refuse a second active conversation', async () => {
    // The test above can pass without an index — if the two calls happen to
    // serialise, the second one simply reads the first one's committed row.
    // This is the part that cannot: an insert that the application would never
    // make, refused by Postgres itself.
    expect(conversationId, 'the previous test must have created a conversation').toBeTruthy();

    const { error } = await admin!
      .from('conversation_sessions')
      .insert({ user_id: userId, status: 'active' });

    expect(error?.code, NOT_APPLIED).toBe('23505');
    expect(error?.message).toContain('conversation_sessions_one_active_per_user_idx');

    // The refusal left nothing behind, and the original is untouched.
    const { data } = await admin!
      .from('conversation_sessions')
      .select('id')
      .eq('user_id', userId)
      .eq('status', 'active');

    expect(data).toHaveLength(1);
    expect(data![0].id).toBe(conversationId);
  }, TIMEOUT);

  it('still allows a closed conversation alongside the active one', async () => {
    // The index is partial. If that were ever lost, this insert would fail and
    // `startNewConversation` — which closes one row and opens another — would
    // start failing in production instead of here.
    const { error } = await admin!
      .from('conversation_sessions')
      .insert({ user_id: userId, status: 'closed' });

    expect(error, 'the index must be partial, not a blanket one-row-per-user rule').toBeNull();

    const { count } = await admin!
      .from('conversation_sessions')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('status', 'closed');

    expect(count).toBe(1);
  }, TIMEOUT);
});
