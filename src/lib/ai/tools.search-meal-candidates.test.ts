import { describe, expect, it } from 'vitest';

import { createFakeSupabase, type Row } from '@/test/fake-supabase';
import type { ServiceContext } from '@/lib/inventory/service';

import { executeTool } from './tools';

/**
 * PHASE 10.3a: the second `search_meal_candidates` call must surface the
 * server-confirmed `missing` list as read-only `shopping_candidates`, built
 * through the PHASE 10.1 pure transform — without writing anything.
 */

const USER_ID = 'user-1';

function seedItem(partial: Row & { name: string }): Row {
  return {
    id: `item-${partial.name}`,
    user_id: USER_ID,
    normalized_name: null,
    category: null,
    quantity: 1,
    unit: null,
    quantity_state: 'available',
    storage_location: null,
    expiry_date: null,
    opened: false,
    notes: null,
    created_at: '2026-08-08T00:00:00Z',
    updated_at: '2026-08-08T00:00:00Z',
    ...partial,
  };
}

function setup(items: Row[] = []): ServiceContext {
  const { client } = createFakeSupabase({ inventory_items: items });
  return { supabase: client, userId: USER_ID };
}

const call = (ctx: ServiceContext, args: Record<string, unknown>) =>
  executeTool(ctx, 'search_meal_candidates', JSON.stringify(args));

type EvaluatedCandidate = {
  title: string;
  bucket: string;
  missing: Array<{ name: string; reason: string; is_staple: boolean }>;
  shopping_candidates: Array<{ name: string; reason: string; is_staple: boolean }>;
};

const baseArgs = {
  max_minutes: null,
  meal_type: null,
  style: null,
  difficulty: null,
  mode: null,
};

describe('search_meal_candidates — shopping_candidates (PHASE 10.3a)', () => {
  it('turns server-confirmed missing ingredients into shopping candidates via the PHASE 10.1 transform', async () => {
    const ctx = setup([seedItem({ name: '鶏もも肉' })]);

    const { result } = await call(ctx, {
      ...baseArgs,
      candidates: [
        {
          title: '肉じゃが',
          required_ingredients: ['鶏もも肉', 'じゃが芋', '玉ねぎ', '人参'],
          optional_ingredients: null,
        },
      ],
    });

    const [candidate] = (result as { evaluated_candidates: EvaluatedCandidate[] })
      .evaluated_candidates;

    expect(candidate.shopping_candidates.map((c) => c.name).sort()).toEqual(
      ['じゃが芋', '人参', '玉ねぎ'].sort(),
    );
  });

  it('preserves reason and is_staple on the shopping candidates', async () => {
    const ctx = setup([]);

    const { result } = await call(ctx, {
      ...baseArgs,
      candidates: [
        {
          title: '卵焼き',
          required_ingredients: ['卵', '砂糖'],
          optional_ingredients: null,
        },
      ],
    });

    const [candidate] = (result as { evaluated_candidates: EvaluatedCandidate[] })
      .evaluated_candidates;

    const sugar = candidate.shopping_candidates.find((c) => c.name === '砂糖');
    expect(sugar).toMatchObject({ reason: 'absent', is_staple: true });

    const egg = candidate.shopping_candidates.find((c) => c.name === '卵');
    expect(egg).toMatchObject({ reason: 'absent', is_staple: false });
  });

  it('returns an empty array when nothing is missing', async () => {
    const ctx = setup([seedItem({ name: '卵' })]);

    const { result } = await call(ctx, {
      ...baseArgs,
      candidates: [
        { title: '卵焼き', required_ingredients: ['卵'], optional_ingredients: null },
      ],
    });

    const [candidate] = (result as { evaluated_candidates: EvaluatedCandidate[] })
      .evaluated_candidates;

    expect(candidate.shopping_candidates).toEqual([]);
  });

  it('keeps the existing missing result alongside shopping_candidates', async () => {
    const ctx = setup([]);

    const { result } = await call(ctx, {
      ...baseArgs,
      candidates: [
        { title: '卵焼き', required_ingredients: ['卵'], optional_ingredients: null },
      ],
    });

    const [candidate] = (result as { evaluated_candidates: EvaluatedCandidate[] })
      .evaluated_candidates;

    expect(candidate.missing).toEqual([
      { name: '卵', reason: 'absent', reason_label: '在庫にない', is_staple: false },
    ]);
  });

  it('does not touch shopping_items or any write dependency', async () => {
    const { client, tables } = createFakeSupabase({
      inventory_items: [],
      shopping_items: [],
    });
    const ctx: ServiceContext = { supabase: client, userId: USER_ID };

    await call(ctx, {
      ...baseArgs,
      candidates: [
        { title: '卵焼き', required_ingredients: ['卵'], optional_ingredients: null },
      ],
    });

    expect(tables.shopping_items).toEqual([]);
  });

  it('leaves the first, candidates: null call unchanged', async () => {
    const ctx = setup([seedItem({ name: '卵' })]);

    const { result } = await call(ctx, { ...baseArgs, candidates: null });

    expect(result).not.toHaveProperty('evaluated_candidates');
    expect(result).toHaveProperty('available_items');
  });
});
