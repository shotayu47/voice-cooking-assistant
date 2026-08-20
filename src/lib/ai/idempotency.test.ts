import { describe, expect, it, vi } from 'vitest';

import { createFakeSupabase, type Tables } from '@/test/fake-supabase';
import type { ServiceContext } from '@/lib/inventory/service';
import { runOnce } from './idempotency';

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

  it('runs a shopping-effect outcome once and replays the stored effect for the same call_id', async () => {
    // PHASE 10.5b: the route nulls the effect on replay, but runOnce itself
    // must keep executing exactly once and hand back the same stored
    // ToolOutcome (including its effect) for a duplicate call_id.
    const { ctx } = setup();
    const run = vi
      .fn()
      .mockResolvedValue({ result: { added: [{ name: '卵' }] }, effect: 'shopping_changed' });

    const first = await runOnce(ctx, 'call_shopping', 'add_selected_shopping_candidates', run);
    const second = await runOnce(ctx, 'call_shopping', 'add_selected_shopping_candidates', run);

    expect(run).toHaveBeenCalledTimes(1);
    expect(first).toMatchObject({ duplicate: false, value: { effect: 'shopping_changed' } });
    expect(second).toMatchObject({ duplicate: true, value: { effect: 'shopping_changed' } });
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
