import { describe, expect, it } from 'vitest';

import { createFakeSupabase, type Row, type Tables } from '@/test/fake-supabase';
import { ServiceError, type ServiceContext } from '@/lib/inventory/service';

import {
  clearCheckedShoppingItems,
  createShoppingItem,
  deleteShoppingItem,
  listShoppingItems,
  setShoppingItemChecked,
} from './service';

const USER_ID = 'user-1';
const OTHER_USER_ID = 'user-2';

/** A uuid the zod schemas accept — the real ids are uuids too. */
function uuid(suffix: number): string {
  return `00000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`;
}

function seedItem(overrides: Row = {}): Row {
  return {
    id: uuid(1),
    user_id: USER_ID,
    name: '卵',
    normalized_name: '卵',
    quantity: null,
    unit: null,
    checked: false,
    checked_at: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function setup(seed: Row[] = []): { ctx: ServiceContext; tables: Tables } {
  const { client, tables } = createFakeSupabase({ shopping_items: seed });
  return { ctx: { supabase: client, userId: USER_ID }, tables };
}

function rows(tables: Tables): Row[] {
  return tables.shopping_items ?? [];
}

describe('createShoppingItem', () => {
  it('stamps the owner on every new row', async () => {
    const { ctx, tables } = setup();

    const { item } = await createShoppingItem(ctx, { name: '牛乳' });

    expect(item.user_id).toBe(USER_ID);
    expect(rows(tables)[0].user_id).toBe(USER_ID);
  });

  it('always writes a normalized name, resolving aliases', async () => {
    const { ctx } = setup();

    const { item } = await createShoppingItem(ctx, { name: 'たまご' });

    // Same canonical form inventory would store, so PHASE 10 can match them.
    expect(item.normalized_name).toBe('卵');
    expect(item.normalized_name.trim()).not.toBe('');
  });

  it('creates a line with no quantity or unit', async () => {
    const { ctx } = setup();

    const { item } = await createShoppingItem(ctx, { name: '牛乳' });

    expect(item.quantity).toBeNull();
    expect(item.unit).toBeNull();
  });

  it('creates a line with a quantity and unit', async () => {
    const { ctx } = setup();

    const { item } = await createShoppingItem(ctx, { name: '卵', quantity: 6, unit: '個' });

    expect(item.quantity).toBe(6);
    expect(item.unit).toBe('個');
  });

  it('starts every line unchecked', async () => {
    const { ctx } = setup();

    const { item } = await createShoppingItem(ctx, { name: '牛乳' });

    expect(item.checked).toBe(false);
    expect(item.checked_at).toBeNull();
  });

  it('rejects a blank name', async () => {
    const { ctx, tables } = setup();

    await expect(createShoppingItem(ctx, { name: '   ' })).rejects.toThrow();
    expect(rows(tables)).toHaveLength(0);
  });

  it('rejects a non-positive quantity', async () => {
    const { ctx } = setup();

    await expect(createShoppingItem(ctx, { name: '卵', quantity: 0 })).rejects.toThrow();
    await expect(createShoppingItem(ctx, { name: '卵', quantity: -1 })).rejects.toThrow();
  });

  it('rejects a unit with no quantity', async () => {
    const { ctx, tables } = setup();

    // Both shapes of "no quantity": the field omitted, and the field cleared.
    // Only checking against null let the omitted form through.
    await expect(createShoppingItem(ctx, { name: '卵', unit: '個' })).rejects.toThrow();
    await expect(
      createShoppingItem(ctx, { name: '卵', quantity: null, unit: '個' }),
    ).rejects.toThrow();
    expect(rows(tables)).toHaveLength(0);
  });

  it('reports a duplicate but still adds the line separately', async () => {
    const { ctx, tables } = setup([seedItem({ name: 'たまご' })]);

    const { item, duplicates } = await createShoppingItem(ctx, { name: '卵', quantity: 6, unit: '個' });

    expect(duplicates.map((d) => d.id)).toEqual([uuid(1)]);
    // Reported, not merged: two rows, and the existing one is untouched.
    expect(rows(tables)).toHaveLength(2);
    expect(rows(tables)[0].quantity).toBeNull();
    expect(item.quantity).toBe(6);
  });

  it('does not report a checked line as a duplicate', async () => {
    const { ctx } = setup([
      seedItem({ checked: true, checked_at: '2026-01-02T00:00:00Z' }),
    ]);

    const { duplicates } = await createShoppingItem(ctx, { name: '卵' });

    expect(duplicates).toEqual([]);
  });

  it("does not report another user's line as a duplicate", async () => {
    const { ctx } = setup([seedItem({ id: uuid(9), user_id: OTHER_USER_ID })]);

    const { duplicates } = await createShoppingItem(ctx, { name: '卵' });

    expect(duplicates).toEqual([]);
  });
});

describe('listShoppingItems', () => {
  it("excludes other users' items", async () => {
    const { ctx } = setup([
      seedItem({ id: uuid(1), name: '卵' }),
      seedItem({ id: uuid(2), name: '牛乳', user_id: OTHER_USER_ID }),
    ]);

    const items = await listShoppingItems(ctx);

    expect(items.map((item) => item.id)).toEqual([uuid(1)]);
  });

  it('orders unchecked before checked, then oldest first', async () => {
    const { ctx } = setup([
      seedItem({ id: uuid(1), name: '古い済', checked: true, checked_at: '2026-01-05T00:00:00Z', created_at: '2026-01-01T00:00:00Z' }),
      seedItem({ id: uuid(2), name: '新しい未', created_at: '2026-01-04T00:00:00Z' }),
      seedItem({ id: uuid(3), name: '古い未', created_at: '2026-01-02T00:00:00Z' }),
      seedItem({ id: uuid(4), name: '新しい済', checked: true, checked_at: '2026-01-06T00:00:00Z', created_at: '2026-01-03T00:00:00Z' }),
    ]);

    const items = await listShoppingItems(ctx);

    expect(items.map((item) => item.id)).toEqual([uuid(3), uuid(2), uuid(1), uuid(4)]);
  });

  it('returns an empty list rather than failing when there is nothing', async () => {
    const { ctx } = setup();

    expect(await listShoppingItems(ctx)).toEqual([]);
  });

  it('surfaces a database error instead of swallowing it', async () => {
    const { ctx } = setup();
    ctx.supabase = {
      from: () => ({
        select: () => ({
          eq: () => ({
            order: () => ({
              order: () => Promise.resolve({ data: null, error: { message: 'boom' } }),
            }),
          }),
        }),
      }),
    } as unknown as ServiceContext['supabase'];

    await expect(listShoppingItems(ctx)).rejects.toBeInstanceOf(ServiceError);
    await expect(listShoppingItems(ctx)).rejects.toThrow('boom');
  });
});

describe('setShoppingItemChecked', () => {
  it('sets checked_at when ticking a line', async () => {
    const { ctx, tables } = setup([seedItem()]);

    const item = await setShoppingItemChecked(ctx, uuid(1), true);

    expect(item?.checked).toBe(true);
    expect(item?.checked_at).not.toBeNull();
    expect(rows(tables)[0].checked_at).not.toBeNull();
  });

  it('clears checked_at when unticking a line', async () => {
    const { ctx, tables } = setup([
      seedItem({ checked: true, checked_at: '2026-01-02T00:00:00Z' }),
    ]);

    const item = await setShoppingItemChecked(ctx, uuid(1), false);

    expect(item?.checked).toBe(false);
    expect(item?.checked_at).toBeNull();
    expect(rows(tables)[0].checked_at).toBeNull();
  });

  it("will not tick another user's line", async () => {
    const { ctx, tables } = setup([seedItem({ user_id: OTHER_USER_ID })]);

    const item = await setShoppingItemChecked(ctx, uuid(1), true);

    expect(item).toBeNull();
    expect(rows(tables)[0].checked).toBe(false);
  });

  it('returns null when the line is already gone', async () => {
    const { ctx } = setup();

    expect(await setShoppingItemChecked(ctx, uuid(1), true)).toBeNull();
  });
});

describe('deleteShoppingItem', () => {
  it('removes one line', async () => {
    const { ctx, tables } = setup([seedItem({ id: uuid(1) }), seedItem({ id: uuid(2) })]);

    expect(await deleteShoppingItem(ctx, uuid(1))).toEqual({ deleted: 1 });
    expect(rows(tables).map((row) => row.id)).toEqual([uuid(2)]);
  });

  it("will not delete another user's line", async () => {
    const { ctx, tables } = setup([seedItem({ user_id: OTHER_USER_ID })]);

    expect(await deleteShoppingItem(ctx, uuid(1))).toEqual({ deleted: 0 });
    expect(rows(tables)).toHaveLength(1);
  });

  it('is safe to call twice', async () => {
    const { ctx, tables } = setup([seedItem()]);

    expect(await deleteShoppingItem(ctx, uuid(1))).toEqual({ deleted: 1 });
    expect(await deleteShoppingItem(ctx, uuid(1))).toEqual({ deleted: 0 });
    expect(rows(tables)).toHaveLength(0);
  });
});

describe('clearCheckedShoppingItems', () => {
  it('removes the checked lines and keeps the rest', async () => {
    const { ctx, tables } = setup([
      seedItem({ id: uuid(1), name: '卵', checked: true, checked_at: '2026-01-02T00:00:00Z' }),
      seedItem({ id: uuid(2), name: '牛乳' }),
      seedItem({ id: uuid(3), name: 'パン', checked: true, checked_at: '2026-01-02T00:00:00Z' }),
    ]);

    expect(await clearCheckedShoppingItems(ctx)).toEqual({ deleted: 2 });
    expect(rows(tables).map((row) => row.id)).toEqual([uuid(2)]);
  });

  it("leaves other users' checked lines alone", async () => {
    // The regression that matters most: a bulk delete missing its user_id
    // filter would empty everyone's list at once.
    const { ctx, tables } = setup([
      seedItem({ id: uuid(1), checked: true, checked_at: '2026-01-02T00:00:00Z' }),
      seedItem({
        id: uuid(2),
        user_id: OTHER_USER_ID,
        checked: true,
        checked_at: '2026-01-02T00:00:00Z',
      }),
    ]);

    expect(await clearCheckedShoppingItems(ctx)).toEqual({ deleted: 1 });
    expect(rows(tables).map((row) => row.id)).toEqual([uuid(2)]);
  });

  it('deletes nothing when no line is checked', async () => {
    const { ctx, tables } = setup([seedItem()]);

    expect(await clearCheckedShoppingItems(ctx)).toEqual({ deleted: 0 });
    expect(rows(tables)).toHaveLength(1);
  });
});
