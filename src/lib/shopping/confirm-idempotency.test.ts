import { describe, expect, it, vi } from 'vitest';

import { createFakeSupabase, type Row, type Tables } from '@/test/fake-supabase';
import type { ServiceContext } from '@/lib/inventory/service';
import {
  IdempotencyUnavailableError,
  IdempotentWriteUnresolvedError,
  runOnce,
} from '@/lib/ai/idempotency';

import {
  runAddSuggested,
  shouldRotateRequestId,
  type AddSuggestedResult,
  type ShoppingDeps,
} from './actions-core';
import { createShoppingItem, listShoppingItems } from './service';

/**
 * The confirmation path composed the way the Server Action composes it:
 * `runOnce(..., { failClosed: true })` around `runAddSuggested`.
 *
 * The unit tests either side of this prove the pieces. What can only go wrong
 * here is the join between them — a request key that is reused when it should
 * have been rotated, or a ledger failure that releases a claim after rows were
 * already written. Both end the same way: the user is charged twice for one
 * press.
 */

const USER_ID = 'user-1';

function setup(): { ctx: ServiceContext; tables: Tables; deps: ShoppingDeps } {
  const { client, tables } = createFakeSupabase({ shopping_items: [], ai_tool_calls: [] });
  const ctx: ServiceContext = { supabase: client, userId: USER_ID };

  const deps: ShoppingDeps = {
    create: (input) => createShoppingItem(ctx, input),
    setChecked: async () => null,
    remove: async () => ({ deleted: 0 }),
    clearChecked: async () => ({ deleted: 0 }),
    revalidate: () => {},
    log: () => {},
  };

  return { ctx, tables, deps };
}

const pick = (name: string) => ({ name, quantity: null, unit: null });

/** The action's composition, minus the auth lookup. */
function confirm(
  ctx: ServiceContext,
  deps: ShoppingDeps,
  requestId: string | null,
  picked: { name: string; quantity: number | null; unit: string | null }[],
) {
  return runOnce(
    ctx,
    requestId,
    'add_suggested_shopping_items',
    () => runAddSuggested(deps, picked),
    { failClosed: true },
  );
}

function names(tables: Tables): string[] {
  return (tables.shopping_items ?? []).map((row) => String((row as Row).name));
}

describe('request key lifecycle', () => {
  it('adds once when the same submit arrives twice', async () => {
    const { ctx, tables, deps } = setup();

    const first = await confirm(ctx, deps, 'req-1', [pick('玉ねぎ'), pick('人参')]);
    const second = await confirm(ctx, deps, 'req-1', [pick('玉ねぎ'), pick('人参')]);

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(names(tables)).toEqual(['玉ねぎ', '人参']);
  });

  it('adds the next selection when a new key is used after a completed run', async () => {
    // The regression the `useRef`-only design had: keeping the spent key
    // would replay the first result and add nothing.
    const { ctx, tables, deps } = setup();

    await confirm(ctx, deps, 'req-1', [pick('玉ねぎ')]);
    const second = await confirm(ctx, deps, 'req-2', [pick('じゃが芋')]);

    expect(second.duplicate).toBe(false);
    expect((second.value as AddSuggestedResult).added).toEqual(['じゃが芋']);
    expect(names(tables)).toEqual(['玉ねぎ', 'じゃが芋']);
  });

  it('does not re-add the successful lines when the failed one is retried', async () => {
    const { ctx, tables, deps } = setup();
    let attempt = 0;
    const flaky: ShoppingDeps = {
      ...deps,
      create: async (input) => {
        attempt += 1;
        // 「人参」 fails the first time only.
        if (input.name === '人参' && attempt <= 2) throw new Error('transient');
        return deps.create(input);
      },
    };

    const first = await confirm(ctx, flaky, 'req-1', [pick('玉ねぎ'), pick('人参')]);
    const firstResult = first.value as AddSuggestedResult;

    expect(firstResult.added).toEqual(['玉ねぎ']);
    expect(firstResult.failed.map((entry) => entry.name)).toEqual(['人参']);

    // The user reselects only what failed and presses again — a new card
    // press, so a new key.
    const retry = await confirm(ctx, flaky, 'req-2', [pick('人参')]);

    expect((retry.value as AddSuggestedResult).added).toEqual(['人参']);
    // 玉ねぎ appears once, not twice.
    expect(names(tables)).toEqual(['玉ねぎ', '人参']);
  });

  it('rotates the key only after a completed run', () => {
    expect(shouldRotateRequestId('done')).toBe(true);

    // Everything else either never reached the ledger or left the outcome
    // open. Rotating would turn the next press into a second write.
    expect(shouldRotateRequestId('rejected')).toBe(false);
    expect(shouldRotateRequestId('in_flight')).toBe(false);
    expect(shouldRotateRequestId('unavailable')).toBe(false);
    expect(shouldRotateRequestId('unknown')).toBe(false);
  });
});

describe('ledger failures', () => {
  /** A client whose ledger calls fail at the chosen stage. */
  function ledgerFailingAt(stage: 'claim' | 'store'): {
    ctx: ServiceContext;
    tables: Tables;
    deps: ShoppingDeps;
  } {
    const base = setup();
    const real = base.ctx.supabase;

    const patched = {
      from(table: string) {
        const builder = (real as unknown as { from: (t: string) => Record<string, unknown> }).from(
          table,
        );
        if (table !== 'ai_tool_calls') return builder;

        if (stage === 'claim') {
          return {
            ...builder,
            upsert: () => ({
              select: async () => ({ data: null, error: { message: 'claim down' } }),
            }),
          };
        }

        return {
          ...builder,
          // The claim succeeds; storing the outcome does not.
          update: () => ({
            eq: () => ({
              eq: async () => ({ data: null, error: { message: 'store down' } }),
            }),
          }),
        };
      },
    };

    const ctx: ServiceContext = {
      userId: USER_ID,
      supabase: patched as unknown as ServiceContext['supabase'],
    };

    return {
      ctx,
      tables: base.tables,
      deps: { ...base.deps, create: (input) => createShoppingItem(ctx, input) },
    };
  }

  it('writes nothing when the claim cannot be made', async () => {
    const { ctx, tables, deps } = ledgerFailingAt('claim');

    await expect(confirm(ctx, deps, 'req-1', [pick('玉ねぎ')])).rejects.toBeInstanceOf(
      IdempotencyUnavailableError,
    );

    expect(names(tables)).toEqual([]);
  });

  it('writes nothing when no key is supplied', async () => {
    const { ctx, tables, deps } = setup();

    await expect(confirm(ctx, deps, null, [pick('玉ねぎ')])).rejects.toBeInstanceOf(
      IdempotencyUnavailableError,
    );

    expect(names(tables)).toEqual([]);
  });

  it('reports the outcome as unstored when it cannot be recorded', async () => {
    const { ctx, tables, deps } = ledgerFailingAt('store');

    const result = await confirm(ctx, deps, 'req-1', [pick('玉ねぎ')]);

    // The row exists; the record of it does not. The action turns this into
    // 「結果を確定できません」 rather than a retry offer.
    expect(names(tables)).toEqual(['玉ねぎ']);
    expect(result.stored).toBe(false);
  });

  it('refuses a retry after an unstored outcome instead of adding again', async () => {
    const { ctx, tables, deps } = ledgerFailingAt('store');

    await confirm(ctx, deps, 'req-1', [pick('玉ねぎ')]);
    const retry = await confirm(ctx, deps, 'req-1', [pick('玉ねぎ')]);

    // The claim is still held, so the second press is answered, not run.
    expect(retry.duplicate).toBe(true);
    expect(names(tables)).toEqual(['玉ねぎ']);
  });

  describe('when the callback itself throws', () => {
    /** runAddSuggested never throws, so this stands in for a bug that makes it. */
    function throwingRun(tables: Tables, ctx: ServiceContext) {
      return async () => {
        // Write one row, then fail — the dangerous shape.
        await createShoppingItem(ctx, { name: '玉ねぎ' });
        void tables;
        throw new Error('boom');
      };
    }

    it('keeps the claim so a retry cannot re-run the write', async () => {
      const { ctx, tables } = setup();

      await expect(
        runOnce(ctx, 'req-1', 'add_suggested_shopping_items', throwingRun(tables, ctx), {
          failClosed: true,
        }),
      ).rejects.toBeInstanceOf(IdempotentWriteUnresolvedError);

      expect(names(tables)).toEqual(['玉ねぎ']);

      // Retrying the same key must not run the callback a second time.
      const retry = await runOnce(
        ctx,
        'req-1',
        'add_suggested_shopping_items',
        throwingRun(tables, ctx),
        { failClosed: true },
      );

      expect(retry.duplicate).toBe(true);
      expect(names(tables)).toEqual(['玉ねぎ']);
    });

    it('still releases the claim for a read, where nothing was written', async () => {
      const { ctx } = setup();
      const run = vi.fn().mockRejectedValue(new Error('read failed'));

      await expect(runOnce(ctx, 'call-1', 'get_inventory', run)).rejects.toThrow('read failed');

      // Released, so a genuine retry can run.
      const second = await runOnce(ctx, 'call-1', 'get_inventory', async () => ({ ok: true }));
      expect(second.duplicate).toBe(false);
    });
  });
});

describe('the guarantee this provides', () => {
  it('is at-most-once, not exactly-once', async () => {
    // A completed run is recorded and replayed; an unresolved one stops. What
    // is never promised is that the work definitely happened — only that it
    // did not happen twice.
    const { ctx, tables, deps } = setup();

    await confirm(ctx, deps, 'req-1', [pick('玉ねぎ')]);
    await confirm(ctx, deps, 'req-1', [pick('玉ねぎ')]);
    await confirm(ctx, deps, 'req-1', [pick('玉ねぎ')]);

    expect(names(tables)).toEqual(['玉ねぎ']);
    expect(await listShoppingItems(ctx)).toHaveLength(1);
  });
});
