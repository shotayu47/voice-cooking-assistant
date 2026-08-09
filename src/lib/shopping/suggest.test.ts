import { describe, expect, it } from 'vitest';

import type { InventoryItem, RecipeIngredient, ShoppingItem } from '@/types/domain';

import {
  MAX_SUGGESTION_RECIPES,
  buildShoppingSuggestions,
  normalizeRecipeIds,
  type SuggestionRecipe,
} from './suggest';

/**
 * PHASE 10 — the server decides what is worth buying.
 *
 * The model supplies recipe ids and nothing else, so these cover the part it
 * cannot influence: which ingredients are missing, why, and how much.
 */

const TODAY = '2026-08-10';

function item(name: string, overrides: Partial<InventoryItem> = {}): InventoryItem {
  return {
    id: `id-${name}`,
    user_id: 'user',
    name,
    normalized_name: name,
    category: null,
    quantity: 1,
    unit: null,
    quantity_state: 'available',
    storage_location: 'fridge',
    expiry_date: null,
    opened: false,
    notes: null,
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-01T00:00:00Z',
    ...overrides,
  };
}

function listed(name: string, overrides: Partial<ShoppingItem> = {}): ShoppingItem {
  return {
    id: `shop-${name}`,
    user_id: 'user',
    name,
    normalized_name: name,
    quantity: null,
    unit: null,
    checked: false,
    checked_at: null,
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-01T00:00:00Z',
    ...overrides,
  };
}

function ing(name: string, overrides: Partial<RecipeIngredient> = {}): RecipeIngredient {
  return { name, required: true, ...overrides };
}

function recipe(
  id: string,
  title: string,
  ingredients: RecipeIngredient[],
): SuggestionRecipe {
  return { id, title, ingredients };
}

const build = (
  recipes: SuggestionRecipe[],
  inventory: InventoryItem[] = [],
  shopping: ShoppingItem[] = [],
  options: { includeStaples?: boolean } = {},
) => buildShoppingSuggestions(recipes, inventory, shopping, { ...options, today: TODAY });

describe('normalizeRecipeIds', () => {
  const A = '11111111-1111-4111-8111-111111111111';
  const B = '22222222-2222-4222-8222-222222222222';

  it('keeps well-formed uuids', () => {
    expect(normalizeRecipeIds([A, B])).toEqual([A, B]);
  });

  it('drops anything that is not a uuid', () => {
    // The id is the only thing the model hands us, so it is the one thing
    // that has to be checked before it reaches a query.
    expect(normalizeRecipeIds([A, 'not-an-id', '', '1; drop table', 42, null])).toEqual([A]);
  });

  it('removes duplicates, keeping the first', () => {
    expect(normalizeRecipeIds([A, A, B, A])).toEqual([A, B]);
  });

  it('lowercases so the same id in different case is one id', () => {
    expect(normalizeRecipeIds([A.toUpperCase(), A])).toEqual([A]);
  });

  it(`caps the list at ${MAX_SUGGESTION_RECIPES}`, () => {
    const many = Array.from(
      { length: 12 },
      (_, index) => `1111111${index % 10}-1111-4111-8111-11111111111${index % 10}`,
    );

    expect(normalizeRecipeIds(many)).toHaveLength(MAX_SUGGESTION_RECIPES);
  });

  it('returns nothing for a non-array', () => {
    expect(normalizeRecipeIds(null)).toEqual([]);
    expect(normalizeRecipeIds('id')).toEqual([]);
  });
});

describe('buildShoppingSuggestions — what counts as missing', () => {
  it('suggests an ingredient the fridge does not have', () => {
    const result = build([recipe('r1', '肉じゃが', [ing('じゃが芋')])]);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ name: 'じゃが芋', reason: 'absent', reasonLabel: '在庫にない' });
  });

  it('does not suggest something already in the fridge', () => {
    expect(build([recipe('r1', '卵焼き', [ing('卵')])], [item('卵')])).toEqual([]);
  });

  it('suggests an item that is in the fridge but used up', () => {
    const result = build(
      [recipe('r1', '卵焼き', [ing('卵')])],
      [item('卵', { quantity_state: 'empty' })],
    );

    expect(result[0]).toMatchObject({ reason: 'out_of_stock', reasonLabel: '在庫切れ' });
  });

  it('suggests an item past its 消費期限', () => {
    const result = build(
      [recipe('r1', '親子丼', [ing('鶏もも肉')])],
      [item('鶏もも肉', { expiry_date: '2026-08-01', expiry_kind: 'use_by' } as Partial<InventoryItem>)],
    );

    expect(result[0]).toMatchObject({ reason: 'expired', reasonLabel: '消費期限切れ' });
  });

  it('resolves through the same normalization the rest of the app uses', () => {
    // 「鶏もも」 finds 鶏もも肉, so it is not proposed as missing.
    expect(build([recipe('r1', '照り焼き', [ing('鶏もも')])], [item('鶏もも肉')])).toEqual([]);
  });

  it('never proposes optional ingredients', () => {
    const result = build([
      recipe('r1', 'サラダ', [ing('レタス'), ing('くるみ', { required: false })]),
    ]);

    expect(result.map((entry) => entry.name)).toEqual(['レタス']);
  });

  it('skips a recipe with no required ingredients', () => {
    expect(build([recipe('r1', '空', [ing('飾り', { required: false })])])).toEqual([]);
  });
});

describe('buildShoppingSuggestions — staples', () => {
  it('leaves seasonings out by default', () => {
    const result = build([recipe('r1', '照り焼き', [ing('鶏もも肉'), ing('醤油')])]);

    expect(result.map((entry) => entry.name)).toEqual(['鶏もも肉']);
  });

  it('includes them when asked', () => {
    const result = build(
      [recipe('r1', '照り焼き', [ing('鶏もも肉'), ing('醤油')])],
      [],
      [],
      { includeStaples: true },
    );

    expect(result.map((entry) => entry.name)).toEqual(['鶏もも肉', '醤油']);
    expect(result[1].isStaple).toBe(true);
  });
});

describe('buildShoppingSuggestions — amounts', () => {
  it("carries the recipe's own amount and unit", () => {
    const result = build([
      recipe('r1', '肉じゃが', [ing('じゃが芋', { amount: 3, unit: '個' })]),
    ]);

    expect(result[0]).toMatchObject({ quantity: 3, unit: '個' });
  });

  it('allows a quantity with no unit', () => {
    const result = build([recipe('r1', '卵焼き', [ing('卵', { amount: 2 })])]);

    expect(result[0]).toMatchObject({ quantity: 2, unit: null });
  });

  it('drops a unit that has no quantity, because a bare unit says nothing', () => {
    const result = build([recipe('r1', '味噌汁', [ing('味噌', { unit: 'g' })])], [], [], {
      includeStaples: true,
    });

    expect(result[0]).toMatchObject({ quantity: null, unit: null });
  });

  it('leaves the amount empty when the recipe has none', () => {
    const result = build([recipe('r1', '肉じゃが', [ing('玉ねぎ')])]);

    expect(result[0]).toMatchObject({ quantity: null, unit: null });
  });

  it('never invents an amount for a non-positive one', () => {
    const result = build([recipe('r1', '肉じゃが', [ing('玉ねぎ', { amount: 0, unit: '個' })])]);

    expect(result[0]).toMatchObject({ quantity: null, unit: null });
  });
});

describe('buildShoppingSuggestions — the same ingredient in two recipes', () => {
  const twoDishes = [
    recipe('r1', '肉じゃが', [ing('玉ねぎ', { amount: 1, unit: '個' })]),
    recipe('r2', 'カレー', [ing('玉ねぎ', { amount: 2, unit: '個' })]),
  ];

  it('merges into one suggestion', () => {
    expect(build(twoDishes)).toHaveLength(1);
  });

  it('records every recipe that wanted it', () => {
    expect(build(twoDishes)[0].sourceRecipes).toEqual([
      { recipeId: 'r1', title: '肉じゃが' },
      { recipeId: 'r2', title: 'カレー' },
    ]);
  });

  it('drops the amount rather than adding the two together', () => {
    // 1個 + 2個 would be arithmetic the user never asked for, and 「大さじ2」
    // plus 「200g」 cannot be added at all.
    expect(build(twoDishes)[0]).toMatchObject({ quantity: null, unit: null });
  });

  it('merges across spellings of the same ingredient', () => {
    const result = build([
      recipe('r1', '卵焼き', [ing('卵')]),
      recipe('r2', '親子丼', [ing('たまご')]),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].sourceRecipes).toHaveLength(2);
  });

  it('does not record the same recipe twice', () => {
    const result = build([recipe('r1', '卵料理', [ing('卵'), ing('たまご')])]);

    expect(result[0].sourceRecipes).toEqual([{ recipeId: 'r1', title: '卵料理' }]);
  });
});

describe('buildShoppingSuggestions — items already on the list', () => {
  it('flags one that is already there, and still suggests it', () => {
    // PHASE 9's rule: warn, never merge and never refuse.
    const result = build([recipe('r1', '卵焼き', [ing('卵')])], [], [listed('たまご')]);

    expect(result).toHaveLength(1);
    expect(result[0].alreadyOnList).toBe(true);
  });

  it('does not flag one that was already bought', () => {
    const result = build(
      [recipe('r1', '卵焼き', [ing('卵')])],
      [],
      [listed('卵', { checked: true, checked_at: '2026-08-09T00:00:00Z' })],
    );

    expect(result[0].alreadyOnList).toBe(false);
  });

  it('leaves the flag off when the list is empty', () => {
    expect(build([recipe('r1', '卵焼き', [ing('卵')])])[0].alreadyOnList).toBe(false);
  });
});

describe('buildShoppingSuggestions — nothing to say', () => {
  it('returns nothing without recipes', () => {
    expect(build([])).toEqual([]);
  });

  it('returns nothing when everything is in stock', () => {
    const result = build(
      [recipe('r1', '卵焼き', [ing('卵'), ing('油')])],
      [item('卵'), item('油')],
    );

    expect(result).toEqual([]);
  });
});
