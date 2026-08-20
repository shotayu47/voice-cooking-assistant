import { describe, expect, it } from 'vitest';

import { createFakeSupabase, type Tables } from '@/test/fake-supabase';
import type { ServiceContext } from '@/lib/inventory/service';

import { addSelectedShoppingCandidates } from './add-candidates';
import type { ShoppingCandidate } from './candidates';

const USER_ID = 'user-1';

function candidate(name: string, overrides: Partial<ShoppingCandidate> = {}): ShoppingCandidate {
  return { name, reason: 'absent', isStaple: false, ...overrides };
}

function setup(): { ctx: ServiceContext; tables: Tables } {
  const { client, tables } = createFakeSupabase({ shopping_items: [] });
  return { ctx: { supabase: client, userId: USER_ID }, tables };
}

function rows(tables: Tables) {
  return tables.shopping_items ?? [];
}

describe('addSelectedShoppingCandidates (service boundary)', () => {
  it('writes zero rows when zero candidates are selected', async () => {
    const { ctx, tables } = setup();

    const result = await addSelectedShoppingCandidates(ctx, []);

    expect(result).toEqual([]);
    expect(rows(tables)).toHaveLength(0);
  });

  it('writes exactly the selected candidates through createShoppingItem', async () => {
    const { ctx, tables } = setup();

    const result = await addSelectedShoppingCandidates(ctx, [candidate('卵'), candidate('牛乳')]);

    expect(result.map((r) => r.item.name)).toEqual(['卵', '牛乳']);
    expect(rows(tables).map((r) => r.name)).toEqual(['卵', '牛乳']);
    // Went through the real validation path: owner stamped, name normalized.
    expect(rows(tables).every((r) => r.user_id === USER_ID)).toBe(true);
    expect(rows(tables)[0].normalized_name).toBe('卵');
  });

  it('reports duplicates against existing unpurchased lines without merging', async () => {
    const { ctx, tables } = setup();
    await addSelectedShoppingCandidates(ctx, [candidate('たまご')]);

    const result = await addSelectedShoppingCandidates(ctx, [candidate('卵')]);

    expect(result[0].duplicates).toHaveLength(1);
    expect(rows(tables)).toHaveLength(2);
  });

  it('propagates a validation failure instead of returning a fabricated success', async () => {
    const { ctx, tables } = setup();

    await expect(addSelectedShoppingCandidates(ctx, [candidate('   ')])).rejects.toThrow();
    expect(rows(tables)).toHaveLength(0);
  });
});
