import { describe, expect, it, vi } from 'vitest';

import { createFakeSupabase, type Tables } from '@/test/fake-supabase';
import type { ServiceContext } from '@/lib/inventory/service';
import { IdempotencyUnavailableError, runOnce } from './idempotency';

/**
 * Idempotency ledger (production-readiness audit).
 *
 * "卵2個使った" relayed twice must decrement once. The ledger is keyed on the
 * Realtime call_id, which is stable across retries of the same call.
 */

const USER_ID = 'user-1';

function setup(): { ctx: ServiceContext; tables: Tables } {
  const { client, tables } = createFakeSupabase({ ai_tool_calls: [] });
  return { ctx: { supabase: client, userId: USER_ID }, tables };
}

describe('runOnce', () => {
  it('executes the first call and replays the stored result for a retry', async () => {
    const { ctx } = setup();
    const run = vi.fn().mockResolvedValue({ result: { quantity: 4 } });

    const first = await runOnce(ctx, 'call_1', 'consume_inventory_item', run);
    const second = await runOnce(ctx, 'call_1', 'consume_inventory_item', run);

    expect(run).toHaveBeenCalledTimes(1);
    expect(first).toMatchObject({ duplicate: false, value: { result: { quantity: 4 } } });
    expect(second).toMatchObject({ duplicate: true, value: { result: { quantity: 4 } } });
  });

  it('keeps distinct calls independent', async () => {
    const { ctx } = setup();
    const run = vi.fn().mockResolvedValue({ result: 'ok' });

    await runOnce(ctx, 'call_1', 'consume_inventory_item', run);
    await runOnce(ctx, 'call_2', 'consume_inventory_item', run);

    expect(run).toHaveBeenCalledTimes(2);
  });

  it('runs unguarded when no key is supplied (the text loop guards per turn)', async () => {
    const { ctx } = setup();
    const run = vi.fn().mockResolvedValue({ result: 'ok' });

    await runOnce(ctx, null, 'get_inventory', run);
    await runOnce(ctx, undefined, 'get_inventory', run);

    expect(run).toHaveBeenCalledTimes(2);
  });

  it('records the claim so a concurrent relay cannot also execute', async () => {
    const { ctx, tables } = setup();
    await runOnce(ctx, 'call_1', 'advance_cooking_step', async () => ({ step: 1 }));

    expect(tables.ai_tool_calls).toHaveLength(1);
    expect(tables.ai_tool_calls[0]).toMatchObject({
      user_id: USER_ID,
      call_id: 'call_1',
      tool_name: 'advance_cooking_step',
      status: 'done',
    });
  });

  it('releases the claim when the tool throws, so a real retry can run', async () => {
    const { ctx, tables } = setup();
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error('database unreachable'))
      .mockResolvedValueOnce({ result: 'ok' });

    await expect(runOnce(ctx, 'call_1', 'consume_inventory_item', run)).rejects.toThrow(
      'database unreachable',
    );
    expect(tables.ai_tool_calls).toHaveLength(0);

    const retry = await runOnce(ctx, 'call_1', 'consume_inventory_item', run);

    expect(run).toHaveBeenCalledTimes(2);
    expect(retry).toMatchObject({ duplicate: false, value: { result: 'ok' } });
  });

  it('does not let one user replay another user’s call_id', async () => {
    const { client, tables } = createFakeSupabase({ ai_tool_calls: [] });
    const userOne: ServiceContext = { supabase: client, userId: 'user-1' };
    const userTwo: ServiceContext = { supabase: client, userId: 'user-2' };
    const run = vi.fn().mockResolvedValue({ result: 'ok' });

    await runOnce(userOne, 'call_shared', 'consume_inventory_item', run);
    const other = await runOnce(userTwo, 'call_shared', 'consume_inventory_item', run);

    expect(run).toHaveBeenCalledTimes(2);
    expect(other.duplicate).toBe(false);
    expect(tables.ai_tool_calls).toHaveLength(2);
  });
});

describe('runOnce failClosed — the write mode', () => {
  /** A client whose ledger writes always fail. */
  function brokenLedger(): ServiceContext {
    return {
      userId: USER_ID,
      supabase: {
        from: () => ({
          upsert: () => ({
            select: async () => ({ data: null, error: { message: 'ledger down' } }),
          }),
        }),
      },
    } as unknown as ServiceContext;
  }

  it('refuses to run when the claim cannot be made', async () => {
    // The default mode executes anyway, which for a write would restore the
    // double-add the ledger exists to prevent.
    const ctx = brokenLedger();
    const run = vi.fn();

    await expect(
      runOnce(ctx, 'req_1', 'add_suggested_shopping_items', run, { failClosed: true }),
    ).rejects.toBeInstanceOf(IdempotencyUnavailableError);

    expect(run).not.toHaveBeenCalled();
  });

  it('refuses to run without a key at all', async () => {
    const { ctx } = setup();
    const run = vi.fn();

    await expect(
      runOnce(ctx, null, 'add_suggested_shopping_items', run, { failClosed: true }),
    ).rejects.toBeInstanceOf(IdempotencyUnavailableError);

    expect(run).not.toHaveBeenCalled();
  });

  it('still runs once and replays the result when the ledger works', async () => {
    const { ctx } = setup();
    const run = vi.fn().mockResolvedValue({ added: ['卵'] });

    const first = await runOnce(ctx, 'req_2', 'add_suggested_shopping_items', run, {
      failClosed: true,
    });
    const second = await runOnce(ctx, 'req_2', 'add_suggested_shopping_items', run, {
      failClosed: true,
    });

    expect(run).toHaveBeenCalledTimes(1);
    expect(first).toMatchObject({ duplicate: false, value: { added: ['卵'] } });
    expect(second).toMatchObject({ duplicate: true, value: { added: ['卵'] } });
  });

  it('leaves the existing read behaviour alone', async () => {
    // Same broken ledger, no failClosed: the read still happens.
    const ctx = brokenLedger();
    const run = vi.fn().mockResolvedValue({ ok: true });

    const result = await runOnce(ctx, 'call_9', 'get_inventory', run);

    expect(run).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ duplicate: false, value: { ok: true } });
  });
});
