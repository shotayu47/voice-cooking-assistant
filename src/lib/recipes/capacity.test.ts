import { describe, expect, it } from 'vitest';

import type { InventoryItem, Recipe, UsedIngredient } from '@/types/domain';
import { ingredientProgress, maxServingsFromInventory } from './capacity';
import { withTargetServings } from './scale';

const TODAY = '2026-08-08';

function item(partial: Partial<InventoryItem> & { name: string }): InventoryItem {
  return {
    id: `id-${partial.name}`,
    user_id: 'user',
    normalized_name: null,
    category: null,
    quantity: null,
    unit: null,
    quantity_state: 'available',
    storage_location: null,
    expiry_date: null,
    opened: null,
    notes: null,
    created_at: TODAY,
    updated_at: TODAY,
    ...partial,
  };
}

const recipe: Recipe = {
  title: '鶏の照り焼き',
  servings: 2,
  ingredients: [
    { name: '鶏もも肉', amount: 300, unit: 'g', required: true },
    { name: '玉ねぎ', amount: 1, unit: '個', required: true },
    { name: '青ねぎ', amount: 1, unit: '本', required: false },
  ],
  steps: [
    { index: 0, instruction: '鶏もも肉を切る', ingredientRefs: ['鶏もも肉'] },
    { index: 1, instruction: '玉ねぎを切る', ingredientRefs: ['玉ねぎ'] },
  ],
};

describe('maxServingsFromInventory', () => {
  it('reports an exact maximum when every required amount was measurable', () => {
    const capacity = maxServingsFromInventory(
      recipe,
      [
        item({ name: '鶏もも肉', quantity: 900, unit: 'g' }),
        item({ name: '玉ねぎ', quantity: 4, unit: '個' }),
      ],
      { today: TODAY },
    );

    // 900g / 150g per serving = 6; 4個 / 0.5個 per serving = 8. Chicken wins.
    expect(capacity.status).toBe('exact');
    expect(capacity.maxServings).toBe(6);
    expect(capacity.limiting).toMatchObject({ name: '鶏もも肉', kind: 'quantity' });
    expect(capacity.unverified).toEqual([]);
  });

  it('converts safely across the same dimension', () => {
    const capacity = maxServingsFromInventory(
      recipe,
      [
        item({ name: '鶏もも肉', quantity: 1.2, unit: 'kg' }),
        item({ name: '玉ねぎ', quantity: 4, unit: '個' }),
      ],
      { today: TODAY },
    );

    expect(capacity.maxServings).toBe(8);
  });

  it('refuses to state a flat maximum when something could not be checked', () => {
    const capacity = maxServingsFromInventory(
      recipe,
      [
        item({ name: '鶏もも肉', quantity: 900, unit: 'g' }),
        // In stock, but nobody knows how many. Excluding it silently and
        // announcing 「最大6人分」 would be a confident answer nobody verified.
        item({ name: '玉ねぎ', quantity: null, unit: null }),
      ],
      { today: TODAY },
    );

    expect(capacity.status).toBe('partial');
    expect(capacity.maxServings).toBe(6);
    expect(capacity.unverified).toEqual([
      expect.objectContaining({ name: '玉ねぎ', reason: 'not_tracked' }),
    ]);
  });

  it('marks an uncomparable unit as unverified rather than guessing', () => {
    const capacity = maxServingsFromInventory(
      recipe,
      [
        // 1本 of chicken is not convertible to grams without knowing the pack.
        item({ name: '鶏もも肉', quantity: 2, unit: '本' }),
        item({ name: '玉ねぎ', quantity: 4, unit: '個' }),
      ],
      { today: TODAY },
    );

    expect(capacity.status).toBe('partial');
    expect(capacity.unverified).toContainEqual(
      expect.objectContaining({ name: '鶏もも肉', reason: 'unit_mismatch' }),
    );
  });

  it('reports unknown when nothing at all could be measured', () => {
    const capacity = maxServingsFromInventory(
      recipe,
      [
        item({ name: '鶏もも肉', quantity: null }),
        item({ name: '玉ねぎ', quantity: null }),
      ],
      { today: TODAY },
    );

    expect(capacity.status).toBe('unknown');
    expect(capacity.maxServings).toBeNull();
    expect(capacity.limiting).toBeNull();
  });

  it('treats a missing required ingredient as zero servings', () => {
    const capacity = maxServingsFromInventory(
      recipe,
      [item({ name: '鶏もも肉', quantity: 900, unit: 'g' })],
      { today: TODAY },
    );

    expect(capacity.maxServings).toBe(0);
    expect(capacity.limiting).toMatchObject({ name: '玉ねぎ', reason: 'absent' });
  });

  it('separates 在庫切れ and 消費期限切れ from 在庫にない', () => {
    const outOfStock = maxServingsFromInventory(
      recipe,
      [
        item({ name: '鶏もも肉', quantity: 0, unit: 'g', quantity_state: 'empty' }),
        item({ name: '玉ねぎ', quantity: 4, unit: '個' }),
      ],
      { today: TODAY },
    );
    expect(outOfStock.limiting).toMatchObject({ reason: 'out_of_stock' });

    const expired = maxServingsFromInventory(
      recipe,
      [
        item({
          name: '鶏もも肉',
          quantity: 900,
          unit: 'g',
          expiry_date: '2026-08-06',
          expiry_kind: 'use_by',
        }),
        item({ name: '玉ねぎ', quantity: 4, unit: '個' }),
      ],
      { today: TODAY },
    );
    expect(expired.limiting).toMatchObject({ reason: 'expired' });
  });

  it('does not let an optional ingredient limit the answer', () => {
    const capacity = maxServingsFromInventory(
      recipe,
      [
        item({ name: '鶏もも肉', quantity: 900, unit: 'g' }),
        item({ name: '玉ねぎ', quantity: 4, unit: '個' }),
      ],
      { today: TODAY },
    );

    // 青ねぎ is not in stock at all, and it is optional. Dinner is unaffected.
    expect(capacity.maxServings).toBe(6);
  });

  it('caps at the recipe schema ceiling', () => {
    const capacity = maxServingsFromInventory(
      recipe,
      [
        item({ name: '鶏もも肉', quantity: 50, unit: 'kg' }),
        item({ name: '玉ねぎ', quantity: 200, unit: '個' }),
      ],
      { today: TODAY },
    );

    expect(capacity.maxServings).toBe(20);
    expect(capacity.cappedAtMax).toBe(true);
  });

  it('flags an amount the recipe never specified', () => {
    const vague: Recipe = {
      ...recipe,
      ingredients: [{ name: '塩', required: true }],
    };
    const capacity = maxServingsFromInventory(vague, [item({ name: '塩' })], {
      today: TODAY,
    });

    expect(capacity.status).toBe('unknown');
    expect(capacity.unverified).toContainEqual(
      expect.objectContaining({ name: '塩', reason: 'no_amount' }),
    );
  });

  it('measures against the base servings even when the session is adjusted', () => {
    const adjusted = withTargetServings(recipe, 6);
    const capacity = maxServingsFromInventory(
      adjusted,
      [
        item({ name: '鶏もも肉', quantity: 900, unit: 'g' }),
        item({ name: '玉ねぎ', quantity: 4, unit: '個' }),
      ],
      { today: TODAY },
    );

    // Still 6 servings' worth of chicken — the target does not change how much
    // is in the fridge.
    expect(capacity.maxServings).toBe(6);
  });
});

function used(partial: Partial<UsedIngredient> & { name: string }): UsedIngredient {
  return {
    inventoryItemId: null,
    amount: null,
    unit: null,
    stepIndex: null,
    recordedAt: `${TODAY}T00:00:00Z`,
    ...partial,
  };
}

const progressOf = (entries: ReturnType<typeof ingredientProgress>, name: string) =>
  entries.find((entry) => entry.name === name);

describe('ingredientProgress', () => {
  it('computes what is still owed from what was actually consumed', () => {
    // 300g at 2 servings, now cooking for 4 → 600g needed, 200g already in.
    const entries = ingredientProgress(withTargetServings(recipe, 4), {
      usedIngredients: [used({ name: '鶏もも肉', amount: 200, unit: 'g' })],
      completedSteps: [0],
    });

    expect(progressOf(entries, '鶏もも肉')).toMatchObject({
      status: 'partially_added',
      source: 'used_ingredients',
      requiredAmount: 600,
      usedAmount: 200,
      remainingAmount: 400,
      remainingDisplay: '400g',
    });
  });

  it('adds up several recordings for the same ingredient', () => {
    const entries = ingredientProgress(withTargetServings(recipe, 4), {
      usedIngredients: [
        used({ name: '鶏もも肉', amount: 200, unit: 'g' }),
        used({ name: '鶏もも肉', amount: 0.3, unit: 'kg' }),
      ],
    });

    expect(progressOf(entries, '鶏もも肉')).toMatchObject({
      usedAmount: 500,
      remainingAmount: 100,
    });
  });

  it('says satisfied when enough already went in', () => {
    const entries = ingredientProgress(recipe, {
      usedIngredients: [used({ name: '鶏もも肉', amount: 300, unit: 'g' })],
    });

    expect(progressOf(entries, '鶏もも肉')).toMatchObject({
      status: 'satisfied',
      remainingAmount: 0,
    });
  });

  it('prefers the consumption record over the completed step', () => {
    const entries = ingredientProgress(recipe, {
      usedIngredients: [used({ name: '鶏もも肉', amount: 100, unit: 'g' })],
      completedSteps: [0, 1],
    });

    // Step 0 is done, but the recorded amount is the better answer and it says
    // only 100g of the 300g went in.
    expect(progressOf(entries, '鶏もも肉')).toMatchObject({
      source: 'used_ingredients',
      status: 'partially_added',
      remainingAmount: 200,
    });
  });

  it('treats a completed step as evidence only, never as an amount', () => {
    const entries = ingredientProgress(recipe, {
      usedIngredients: [],
      completedSteps: [1],
    });

    expect(progressOf(entries, '玉ねぎ')).toMatchObject({
      status: 'unknown',
      source: 'completed_steps',
      usedAmount: null,
      remainingAmount: null,
    });
  });

  it('refuses to compute a difference it cannot measure', () => {
    const entries = ingredientProgress(recipe, {
      usedIngredients: [used({ name: '鶏もも肉', amount: 1, unit: '枚' })],
    });

    expect(progressOf(entries, '鶏もも肉')).toMatchObject({
      status: 'unknown',
      source: 'used_ingredients',
      remainingAmount: null,
    });
  });

  it('reports nothing recorded as not started', () => {
    const entries = ingredientProgress(recipe, {});
    expect(progressOf(entries, '鶏もも肉')).toMatchObject({
      status: 'not_started',
      source: 'none',
    });
  });

  it('matches the consumption record through the app-wide name folding', () => {
    const entries = ingredientProgress(recipe, {
      usedIngredients: [used({ name: 'たまねぎ', amount: 1, unit: '個' })],
    });

    expect(progressOf(entries, '玉ねぎ')?.status).toBe('satisfied');
  });

  it('matches on the inventory item id when the names differ', () => {
    const linked: Recipe = {
      ...recipe,
      ingredients: [
        { name: '鶏肉', inventoryItemId: 'item-1', amount: 300, unit: 'g', required: true },
      ],
    };
    const entries = ingredientProgress(linked, {
      usedIngredients: [
        used({ name: '若鶏もも肉（解凍）', inventoryItemId: 'item-1', amount: 300, unit: 'g' }),
      ],
    });

    expect(progressOf(entries, '鶏肉')?.status).toBe('satisfied');
  });

  it('cannot give a remainder for an ingredient with no stated amount', () => {
    const vague: Recipe = { ...recipe, ingredients: [{ name: '塩', required: true }] };
    const entries = ingredientProgress(vague, {
      usedIngredients: [used({ name: '塩', amount: 1, unit: 'g' })],
    });

    expect(progressOf(entries, '塩')).toMatchObject({
      status: 'unknown',
      remainingAmount: null,
    });
  });
});
