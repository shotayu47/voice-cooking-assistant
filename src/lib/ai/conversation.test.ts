import { describe, expect, it } from 'vitest';

import { createFakeSupabase, type Row, type Tables } from '@/test/fake-supabase';
import { ServiceError, type ServiceContext } from '@/lib/inventory/service';

import { getOrCreateConversation, loadMessages, startNewConversation } from './service';

/**
 * One active conversation per user, and starting a new one.
 *
 * The rule this pins is not "the app should only make one" — the app already
 * believed that and the database had three. It is that the *database* refuses
 * a second, and that both the normal path and the deliberate "start over" path
 * cope with losing that race instead of failing or duplicating.
 *
 * `fake-supabase` models the partial unique index from migration 0006, so
 * these exercise the same 23505 the real database raises.
 */

const USER_ID = 'user-1';
const OTHER_USER_ID = 'user-2';

function conversation(overrides: Row = {}): Row {
  return {
    id: 'conv-old',
    user_id: USER_ID,
    cooking_session_id: null,
    status: 'active',
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-01T00:00:00Z',
    ...overrides,
  };
}

function message(overrides: Row = {}): Row {
  return {
    id: 'msg-1',
    conversation_session_id: 'conv-old',
    user_id: USER_ID,
    seq: 1,
    role: 'user',
    content: '何作れる？',
    tool_calls: null,
    tool_call_id: null,
    created_at: '2026-08-01T00:00:00Z',
    ...overrides,
  };
}

function setup(seed: Tables = {}): { ctx: ServiceContext; tables: Tables } {
  const { client, tables } = createFakeSupabase({
    conversation_sessions: [],
    conversation_messages: [],
    ...seed,
  });
  return { ctx: { supabase: client, userId: USER_ID }, tables };
}

const sessions = (tables: Tables) => tables.conversation_sessions ?? [];
const activeOf = (tables: Tables, userId = USER_ID) =>
  sessions(tables).filter((row) => row.user_id === userId && row.status === 'active');

describe('startNewConversation', () => {
  it('keeps the old conversation and every message, closing it only', async () => {
    const { ctx, tables } = setup({
      conversation_sessions: [conversation()],
      conversation_messages: [message({ id: 'm1', seq: 1 }), message({ id: 'm2', seq: 2 })],
    });

    await startNewConversation(ctx);

    const old = sessions(tables).find((row) => row.id === 'conv-old');
    expect(old).toBeDefined();
    expect(old?.status).toBe('closed');
    // Nothing is a delete. The record of what was said is the user's.
    expect(tables.conversation_messages).toHaveLength(2);
  });

  it('leaves exactly one active conversation, and it is the new one', async () => {
    const { ctx, tables } = setup({
      conversation_sessions: [conversation()],
      conversation_messages: [message()],
    });

    const fresh = await startNewConversation(ctx);

    const active = activeOf(tables);
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe(fresh);
    expect(fresh).not.toBe('conv-old');
  });

  it('gives the new conversation no history at all', async () => {
    const { ctx } = setup({
      conversation_sessions: [conversation()],
      conversation_messages: [message()],
    });

    const fresh = await startNewConversation(ctx);

    // What the next turn replays to the model.
    expect(await loadMessages(ctx, fresh)).toEqual([]);
    // And the old one still has its own.
    expect(await loadMessages(ctx, 'conv-old')).toHaveLength(1);
  });

  it('does nothing when the current conversation is already empty', async () => {
    const { ctx, tables } = setup({ conversation_sessions: [conversation()] });

    const first = await startNewConversation(ctx);
    const second = await startNewConversation(ctx);

    expect(first).toBe('conv-old');
    expect(second).toBe('conv-old');
    // No extra rows: pressing twice on a blank conversation is a no-op.
    expect(sessions(tables)).toHaveLength(1);
  });

  it('carries the cooking session onto the new conversation', async () => {
    const { ctx, tables } = setup({
      conversation_sessions: [conversation()],
      conversation_messages: [message()],
    });

    const fresh = await startNewConversation(ctx, 'cook-1');

    expect(sessions(tables).find((row) => row.id === fresh)?.cooking_session_id).toBe('cook-1');
  });

  it("cannot close another user's conversation", async () => {
    const { ctx, tables } = setup({
      conversation_sessions: [conversation({ id: 'theirs', user_id: OTHER_USER_ID })],
    });

    await startNewConversation(ctx);

    // Theirs is untouched, and ours is a separate row.
    expect(sessions(tables).find((row) => row.id === 'theirs')?.status).toBe('active');
    expect(activeOf(tables, OTHER_USER_ID)).toHaveLength(1);
    expect(activeOf(tables)).toHaveLength(1);
  });

  it('settles on one conversation when pressed twice at once', async () => {
    const { ctx, tables } = setup({
      conversation_sessions: [conversation()],
      conversation_messages: [message()],
    });

    const [a, b] = await Promise.all([startNewConversation(ctx), startNewConversation(ctx)]);

    expect(activeOf(tables)).toHaveLength(1);
    expect(a).toBe(b);
    expect(a).not.toBe('conv-old');
  });
});

describe('getOrCreateConversation', () => {
  it('creates one when the user has none', async () => {
    const { ctx, tables } = setup();

    const id = await getOrCreateConversation(ctx);

    expect(activeOf(tables)).toHaveLength(1);
    expect(activeOf(tables)[0].id).toBe(id);
  });

  it('reuses the existing one rather than making a second', async () => {
    const { ctx, tables } = setup({ conversation_sessions: [conversation()] });

    expect(await getOrCreateConversation(ctx)).toBe('conv-old');
    expect(sessions(tables)).toHaveLength(1);
  });

  it('ignores a closed conversation and opens a new one', async () => {
    const { ctx } = setup({ conversation_sessions: [conversation({ status: 'closed' })] });

    expect(await getOrCreateConversation(ctx)).not.toBe('conv-old');
  });

  it('yields one conversation when two requests arrive together', async () => {
    // The race the partial unique index exists for: a page render and a POST
    // both seeing nothing and both inserting.
    const { ctx, tables } = setup();

    const [a, b] = await Promise.all([getOrCreateConversation(ctx), getOrCreateConversation(ctx)]);

    expect(activeOf(tables)).toHaveLength(1);
    expect(a).toBe(b);
  });

  it("does not take another user's conversation", async () => {
    const { ctx } = setup({
      conversation_sessions: [conversation({ id: 'theirs', user_id: OTHER_USER_ID })],
    });

    expect(await getOrCreateConversation(ctx)).not.toBe('theirs');
  });

  it('fails loudly on a database error that is not the race', async () => {
    // A broken connection must not be mistaken for "someone else won".
    const { ctx } = setup();
    ctx.supabase = {
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              order: () => ({
                order: () => ({
                  limit: () => ({
                    maybeSingle: async () => ({ data: null, error: { message: 'boom' } }),
                  }),
                }),
              }),
            }),
          }),
        }),
      }),
    } as unknown as ServiceContext['supabase'];

    await expect(getOrCreateConversation(ctx)).rejects.toBeInstanceOf(ServiceError);
  });
});
