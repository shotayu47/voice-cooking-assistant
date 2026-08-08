import { beforeEach, describe, expect, it } from 'vitest';

import { createFakeSupabase, type Row, type Tables } from '@/test/fake-supabase';
import type { ServiceContext } from '@/lib/inventory/service';

import { executeTool } from './tools';

/**
 * PHASE 8 through the real tool dispatch.
 *
 * The pure tests prove the arithmetic. These prove the part that can only go
 * wrong end-to-end: that adjusting the servings persists, that it does so
 * without overwriting the recipe it was calculated from, and that a second
 * adjustment recalculates rather than compounds.
 */

const USER_ID = 'user-1';

const RECIPE = {
  title: '鶏の照り焼き',
  servings: 2,
  ingredients: [
    { name: '鶏もも肉', amount: 300, unit: 'g', required: true },
    { name: '醤油', amount: 2, unit: '大さじ', required: true },
    { name: '塩', required: true },
  ],
  steps: [
    { index: 0, instruction: '鶏もも肉を一口大に切る', ingredientRefs: ['鶏もも肉'] },
    { index: 1, instruction: '醤油を加えて煮からめる', ingredientRefs: ['醤油'] },
  ],
};

function seedSession(overrides: Row = {}): Row {
  return {
    id: 'session-1',
    user_id: USER_ID,
    recipe_id: 'recipe-1',
    recipe_snapshot: RECIPE,
    current_step: 0,
    total_steps: 2,
    status: 'active',
    completed_steps: [],
    skipped_steps: [],
    used_ingredients: [],
    started_at: '2026-08-08T00:00:00Z',
    completed_at: null,
    last_ai_step_move_at: null,
    created_at: '2026-08-08T00:00:00Z',
    updated_at: '2026-08-08T00:00:00Z',
    ...overrides,
  };
}

function seedItem(partial: Row & { name: string }): Row {
  return {
    id: `item-${partial.name}`,
    user_id: USER_ID,
    normalized_name: null,
    category: null,
    quantity: null,
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

function setup(seed: Tables): { ctx: ServiceContext; tables: Tables } {
  const { client, tables } = createFakeSupabase(seed);
  return { ctx: { supabase: client, userId: USER_ID }, tables };
}

const call = (ctx: ServiceContext, args: Record<string, unknown>) =>
  executeTool(ctx, 'adjust_recipe_amounts', JSON.stringify(args));

type ScaleResult = {
  base_servings: number;
  target_servings: number;
  factor: number;
  saved: boolean;
  ingredients: Array<{ name: string; amount: number | null; display: string; policy: string }>;
  notes: string[];
  already_added?: Array<{ name: string; status: string; remainingAmount: number | null }>;
};

describe('adjust_recipe_amounts — scale', () => {
  let ctx: ServiceContext;
  let tables: Tables;

  beforeEach(() => {
    ({ ctx, tables } = setup({ cooking_sessions: [seedSession()] }));
  });

  it('scales the open session and remembers it', async () => {
    const { result, effect } = await call(ctx, {
      mode: 'scale',
      target_servings: 4,
      session_id: null,
      recipe_id: null,
    });
    const scaled = result as ScaleResult;

    expect(scaled.saved).toBe(true);
    expect(effect).toBe('session_changed');
    expect(scaled.target_servings).toBe(4);
    expect(scaled.ingredients).toContainEqual(
      expect.objectContaining({ name: '鶏もも肉', amount: 600, display: '600g' }),
    );
    expect(scaled.ingredients).toContainEqual(
      expect.objectContaining({ name: '醤油', display: '大さじ4' }),
    );
  });

  it('stores the target without rewriting the amounts it came from', async () => {
    await call(ctx, { mode: 'scale', target_servings: 4, session_id: 'session-1', recipe_id: null });

    const snapshot = tables.cooking_sessions[0].recipe_snapshot as typeof RECIPE & {
      scaling: { baseServings: number; targetServings: number };
    };

    expect(snapshot.scaling).toEqual({ baseServings: 2, targetServings: 4 });
    // The base recipe survives, which is what makes the next change correct.
    expect(snapshot.ingredients).toEqual(RECIPE.ingredients);
    expect(snapshot.steps).toEqual(RECIPE.steps);
  });

  it('recalculates from the base on a second change instead of compounding', async () => {
    await call(ctx, { mode: 'scale', target_servings: 4, session_id: 'session-1', recipe_id: null });
    const second = await call(ctx, {
      mode: 'scale',
      target_servings: 3,
      session_id: 'session-1',
      recipe_id: null,
    });
    const scaled = second.result as ScaleResult;

    // Compounding would give 900g here (300 → 600 → 900). From the base it is 450g.
    expect(scaled.base_servings).toBe(2);
    expect(scaled.ingredients).toContainEqual(
      expect.objectContaining({ name: '鶏もも肉', amount: 450 }),
    );

    const back = await call(ctx, {
      mode: 'scale',
      target_servings: 2,
      session_id: 'session-1',
      recipe_id: null,
    });
    expect((back.result as ScaleResult).ingredients).toContainEqual(
      expect.objectContaining({ name: '鶏もも肉', amount: 300 }),
    );
  });

  it('always returns the heat-and-time rule with an adjustment', async () => {
    const { result } = await call(ctx, {
      mode: 'scale',
      target_servings: 4,
      session_id: 'session-1',
      recipe_id: null,
    });

    expect((result as ScaleResult).notes.join('')).toContain('加熱時間と火力は自動で倍率変更していません');
  });

  it('leaves 適量 without a number', async () => {
    const { result } = await call(ctx, {
      mode: 'scale',
      target_servings: 4,
      session_id: 'session-1',
      recipe_id: null,
    });

    expect((result as ScaleResult).ingredients).toContainEqual(
      expect.objectContaining({ name: '塩', amount: null, policy: 'no_amount' }),
    );
  });

  it('reports what is still owed from the recorded consumption', async () => {
    ({ ctx } = setup({
      cooking_sessions: [
        seedSession({
          current_step: 1,
          completed_steps: [0],
          used_ingredients: [
            {
              name: '鶏もも肉',
              inventoryItemId: 'item-1',
              amount: 200,
              unit: 'g',
              stepIndex: 0,
              recordedAt: '2026-08-08T00:10:00Z',
            },
          ],
        }),
      ],
    }));

    const { result } = await call(ctx, {
      mode: 'scale',
      target_servings: 4,
      session_id: 'session-1',
      recipe_id: null,
    });
    const scaled = result as ScaleResult;

    expect(scaled.already_added).toContainEqual(
      expect.objectContaining({
        name: '鶏もも肉',
        status: 'partially_added',
        remainingAmount: 400,
      }),
    );
  });

  it('refuses a servings count that would produce a nonsense amount', async () => {
    for (const target of [0, -2, 2.5, 99, null]) {
      const { result } = await call(ctx, {
        mode: 'scale',
        target_servings: target,
        session_id: 'session-1',
        recipe_id: null,
      });
      expect(result, `target=${target}`).toMatchObject({ error: 'invalid_arguments' });
    }

    // Nothing was written.
    expect(
      (tables.cooking_sessions[0].recipe_snapshot as { scaling?: unknown }).scaling,
    ).toBeUndefined();
  });

  it('says so rather than guessing when there is no recipe to adjust', async () => {
    ({ ctx } = setup({ cooking_sessions: [] }));

    const { result } = await call(ctx, {
      mode: 'scale',
      target_servings: 4,
      session_id: null,
      recipe_id: null,
    });
    expect(result).toMatchObject({ error: 'recipe_not_found' });
  });

  it('calculates for a saved recipe without persisting anything', async () => {
    ({ ctx, tables } = setup({
      cooking_sessions: [],
      recipes: [
        {
          id: 'recipe-1',
          user_id: USER_ID,
          title: RECIPE.title,
          description: null,
          servings: 2,
          estimated_minutes: null,
          difficulty: null,
          ingredients: RECIPE.ingredients,
          steps: RECIPE.steps,
          source_type: 'ai',
          created_at: '2026-08-08T00:00:00Z',
        },
      ],
    }));

    const { result, effect } = await call(ctx, {
      mode: 'scale',
      target_servings: 4,
      session_id: null,
      recipe_id: 'recipe-1',
    });

    expect((result as ScaleResult).saved).toBe(false);
    expect(effect).toBeUndefined();
    expect(tables.recipes[0].ingredients).toEqual(RECIPE.ingredients);
  });
});

type CapacityResult = {
  capacity_status: 'exact' | 'partial' | 'unknown';
  max_servings: number | null;
  limiting_ingredient: { name: string } | null;
  unverified_constraints: Array<{ name: string; reason: string }>;
  note: string;
};

describe('adjust_recipe_amounts — max_from_inventory', () => {
  it('gives the limiting ingredient but flags what it could not check', async () => {
    const { ctx } = setup({
      cooking_sessions: [seedSession()],
      inventory_items: [
        seedItem({ name: '鶏もも肉', quantity: 900, unit: 'g' }),
        seedItem({ name: '醤油', quantity: 500, unit: 'ml' }),
        seedItem({ name: '塩', quantity: 1, unit: '袋' }),
      ],
    });

    const { result } = await call(ctx, {
      mode: 'max_from_inventory',
      target_servings: null,
      session_id: 'session-1',
      recipe_id: null,
    });
    const capacity = result as CapacityResult;

    // 900g chicken → 6 servings; 500ml soy sauce at 大さじ1 per serving → 33.
    expect(capacity.capacity_status).toBe('partial');
    expect(capacity.max_servings).toBe(6);
    expect(capacity.limiting_ingredient).toMatchObject({ name: '鶏もも肉' });
    // 塩 is 適量 — it has no amount to check, and saying nothing about it would
    // turn an unchecked ingredient into a confident maximum.
    expect(capacity.unverified_constraints).toContainEqual(
      expect.objectContaining({ name: '塩', reason: 'no_amount' }),
    );
    expect(capacity.note).toContain('断定しないでください');
  });

  it('does not change the session', async () => {
    const { ctx, tables } = setup({
      cooking_sessions: [seedSession()],
      inventory_items: [seedItem({ name: '鶏もも肉', quantity: 900, unit: 'g' })],
    });

    const { effect } = await call(ctx, {
      mode: 'max_from_inventory',
      target_servings: null,
      session_id: 'session-1',
      recipe_id: null,
    });

    expect(effect).toBeUndefined();
    expect(
      (tables.cooking_sessions[0].recipe_snapshot as { scaling?: unknown }).scaling,
    ).toBeUndefined();
  });

  it('counts an item that exists but is empty as out of stock, not missing', async () => {
    const { ctx } = setup({
      cooking_sessions: [seedSession()],
      inventory_items: [
        seedItem({ name: '鶏もも肉', quantity: 0, unit: 'g', quantity_state: 'empty' }),
        seedItem({ name: '醤油', quantity: 500, unit: 'ml' }),
      ],
    });

    const { result } = await call(ctx, {
      mode: 'max_from_inventory',
      target_servings: null,
      session_id: 'session-1',
      recipe_id: null,
    });

    expect(result).toMatchObject({
      max_servings: 0,
      limiting_ingredient: { name: '鶏もも肉', reason: 'out_of_stock' },
    });
  });
});
