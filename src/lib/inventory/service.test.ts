import { beforeEach, describe, expect, it } from 'vitest';

import { createFakeSupabase, type Row, type Tables } from '@/test/fake-supabase';
import {
  consumeInventoryItem,
  createInventoryItem,
  deleteInventoryItem,
  findInventoryItemByName,
  listInventory,
  setQuantityState,
  type ServiceContext,
} from './service';

const USER_ID = 'user-1';

function seedItem(overrides: Row = {}): Row {
  return {
    id: 'item-egg',
    user_id: USER_ID,
    name: '卵',
    normalized_name: '卵',
    category: 'egg_dairy',
    quantity: 6,
    unit: '個',
    quantity_state: 'available',
    storage_location: 'fridge',
    expiry_date: null,
    opened: false,
    notes: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function setup(seed: Tables): { ctx: ServiceContext; tables: Tables } {
  const { client, tables } = createFakeSupabase({ inventory_transactions: [], ...seed });
  return { ctx: { supabase: client, userId: USER_ID }, tables };
}

describe('consumeInventoryItem', () => {
  let ctx: ServiceContext;
  let tables: Tables;

  beforeEach(() => {
    ({ ctx, tables } = setup({ inventory_items: [seedItem()] }));
  });

  // SPEC §20 Scenario 4
  it('「卵2個使った」 leaves 4 and logs a transaction', async () => {
    const result = await consumeInventoryItem(
      ctx,
      { itemId: 'item-egg', amount: 2, unit: '個' },
      'ai_text',
    );

    expect(result.status).toBe('applied');
    expect(tables.inventory_items[0].quantity).toBe(4);

    expect(tables.inventory_transactions).toHaveLength(1);
    expect(tables.inventory_transactions[0]).toMatchObject({
      user_id: USER_ID,
      inventory_item_id: 'item-egg',
      action: 'decrease',
      quantity_delta: -2,
      source: 'ai_text',
    });
  });

  // SPEC §12 Example E
  it('「全部使った」 empties the item and logs consume_all', async () => {
    const result = await consumeInventoryItem(
      ctx,
      { itemId: 'item-egg', consumeAll: true },
      'ai_text',
    );

    expect(result.status).toBe('applied');
    expect(tables.inventory_items[0]).toMatchObject({ quantity: 0, quantity_state: 'empty' });
    expect(tables.inventory_transactions[0]).toMatchObject({
      action: 'consume_all',
      quantity_delta: -6,
    });
  });

  it('an ambiguous statement changes nothing and logs nothing', async () => {
    const result = await consumeInventoryItem(ctx, { itemId: 'item-egg' }, 'ai_text');

    expect(result.status).toBe('needs_clarification');
    expect(tables.inventory_items[0].quantity).toBe(6);
    expect(tables.inventory_transactions).toHaveLength(0);
  });

  it('a mismatched unit changes nothing', async () => {
    const result = await consumeInventoryItem(
      ctx,
      { itemId: 'item-egg', amount: 100, unit: 'g' },
      'ai_text',
    );

    expect(result.status).toBe('needs_clarification');
    expect(tables.inventory_items[0].quantity).toBe(6);
    expect(tables.inventory_transactions).toHaveLength(0);
  });

  it('records the before and after snapshots', async () => {
    await consumeInventoryItem(ctx, { itemId: 'item-egg', amount: 1 }, 'manual');

    const transaction = tables.inventory_transactions[0];
    expect(transaction.previous_value).toMatchObject({ quantity: 6 });
    expect(transaction.new_value).toMatchObject({ quantity: 5 });
  });
});

describe('createInventoryItem', () => {
  it('accepts a name on its own and stores a normalized name', async () => {
    const { ctx, tables } = setup({ inventory_items: [] });

    const item = await createInventoryItem(ctx, { name: '鶏もも' }, 'manual');

    expect(item).toMatchObject({
      name: '鶏もも',
      normalized_name: '鶏もも肉',
      quantity: null,
      quantity_state: 'available',
    });
    expect(tables.inventory_transactions[0]).toMatchObject({ action: 'create' });
  });

  it('rejects a blank name', async () => {
    const { ctx } = setup({ inventory_items: [] });
    await expect(createInventoryItem(ctx, { name: '   ' })).rejects.toThrow();
  });
});

describe('listInventory', () => {
  it('hides empty items unless asked for them', async () => {
    const { ctx } = setup({
      inventory_items: [
        seedItem({ id: 'a', name: '玉ねぎ', quantity_state: 'available' }),
        seedItem({ id: 'b', name: '砂糖', quantity_state: 'empty', quantity: 0 }),
      ],
    });

    expect(await listInventory(ctx)).toHaveLength(1);
    expect(await listInventory(ctx, { includeEmpty: true })).toHaveLength(2);
  });

  it('does not return another user’s rows', async () => {
    const { ctx } = setup({
      inventory_items: [
        seedItem({ id: 'mine' }),
        seedItem({ id: 'theirs', user_id: 'user-2' }),
      ],
    });

    const items = await listInventory(ctx, { includeEmpty: true });
    expect(items.map((item) => item.id)).toEqual(['mine']);
  });
});

describe('deleteInventoryItem', () => {
  it('logs the deletion before removing the row', async () => {
    const { ctx, tables } = setup({ inventory_items: [seedItem()] });

    await deleteInventoryItem(ctx, 'item-egg', 'manual');

    expect(tables.inventory_items).toHaveLength(0);
    expect(tables.inventory_transactions[0]).toMatchObject({
      action: 'delete',
      previous_value: { name: '卵', quantity: 6 },
    });
  });
});

describe('setQuantityState', () => {
  it('「使い切った」 empties the item', async () => {
    const { ctx, tables } = setup({ inventory_items: [seedItem()] });

    await setQuantityState(ctx, 'item-egg', 'empty', 'manual');

    expect(tables.inventory_items[0]).toMatchObject({ quantity: 0, quantity_state: 'empty' });
  });
});

describe('findInventoryItemByName', () => {
  it('resolves a spoken name to a single item', async () => {
    const { ctx } = setup({
      inventory_items: [seedItem({ id: 'onion', name: '玉ねぎ', quantity: 2 })],
    });

    const result = await findInventoryItemByName(ctx, 'たまねぎ');
    expect(result.status).toBe('matched');
  });

  it('reports ambiguity rather than choosing', async () => {
    const { ctx } = setup({
      inventory_items: [
        seedItem({ id: 'thigh', name: '鶏もも肉', normalized_name: '鶏もも肉' }),
        seedItem({ id: 'breast', name: '鶏むね肉', normalized_name: '鶏むね肉' }),
      ],
    });

    expect((await findInventoryItemByName(ctx, '鶏')).status).toBe('ambiguous');
  });
});
