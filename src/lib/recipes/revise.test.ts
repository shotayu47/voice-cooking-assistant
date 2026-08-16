import { describe, expect, it } from 'vitest';

import { createFakeSupabase, type Tables } from '@/test/fake-supabase';
import { ServiceError, type ServiceContext } from '@/lib/inventory/service';

import { createRecipe, getRecipe, reviseRecipe } from './service';

/**
 * "顆粒だしではなく出汁から作りたい" changed nothing.
 *
 * There was no tool for revising a recipe, so the model answered in prose and
 * the row kept its 顆粒だし — and when the user then asked for かつお節 in the
 * shopping candidates, it wrote an inventory row instead. The candidates come
 * from the recipe's ingredients, so until the recipe changes, nothing else can.
 *
 * A revision is a new row. The original stays readable, and a session that is
 * mid-cook keeps its own `recipe_snapshot`, so nobody's steps change under
 * their hands.
 */

const USER = 'user-1';

function context(seed: Partial<Tables> = {}) {
  // The fake only materialises a table once something touches it, so both are
  // seeded empty — otherwise counting rows before the first insert reads
  // `undefined` rather than zero.
  const { client, tables } = createFakeSupabase({
    recipes: [],
    cooking_sessions: [],
    ...seed,
  } as Tables);
  return { ctx: { supabase: client, userId: USER } as ServiceContext, tables };
}

function recipeInput(overrides: Record<string, unknown> = {}) {
  return {
    title: 'シンプルな味噌汁',
    servings: 2,
    ingredients: [
      { name: '水', amount: 400, unit: 'ml', required: true },
      { name: '顆粒だし', amount: 1, unit: '本', required: true },
      { name: '味噌', amount: 2, unit: '大さじ', required: true },
    ],
    steps: [
      { index: 0, instruction: '水を沸かす' },
      { index: 1, instruction: '味噌を溶く' },
    ],
    ...overrides,
  };
}

/** The revision the QA session was asking for. */
function dashiFromScratch() {
  return recipeInput({
    ingredients: [
      { name: '水', amount: 400, unit: 'ml', required: true },
      { name: 'かつお節', amount: 10, unit: 'g', required: true },
      { name: '昆布', amount: 5, unit: 'g', required: true },
      { name: '味噌', amount: 2, unit: '大さじ', required: true },
    ],
    steps: [
      { index: 0, instruction: '昆布を水に浸す' },
      { index: 1, instruction: 'かつお節を入れて出汁をとる' },
      { index: 2, instruction: '味噌を溶く' },
    ],
  });
}

describe('a revision keeps the original', () => {
  it('creates one new row and leaves the source alone', async () => {
    const { ctx, tables } = context();
    const source = await createRecipe(ctx, recipeInput());
    const before = tables.recipes.length;

    const { recipe, supersedesRecipeId } = await reviseRecipe(ctx, source.id, dashiFromScratch());

    expect(tables.recipes.length).toBe(before + 1);
    expect(recipe.id).not.toBe(source.id);
    expect(supersedesRecipeId).toBe(source.id);
  });

  it('leaves the source contents untouched', async () => {
    const { ctx } = context();
    const source = await createRecipe(ctx, recipeInput());

    await reviseRecipe(ctx, source.id, dashiFromScratch());

    const reread = await getRecipe(ctx, source.id);
    expect(reread).not.toBeNull();
    expect(reread!.title).toBe(source.title);
    expect(reread!.ingredients.map((i) => i.name)).toContain('顆粒だし');
    expect(reread!.ingredients.map((i) => i.name)).not.toContain('かつお節');
  });

  it('carries the change into the new version', async () => {
    const { ctx } = context();
    const source = await createRecipe(ctx, recipeInput());

    const { recipe } = await reviseRecipe(ctx, source.id, dashiFromScratch());

    expect(recipe.ingredients.map((i) => i.name)).toContain('かつお節');
    expect(recipe.ingredients.map((i) => i.name)).not.toContain('顆粒だし');
    expect(recipe.steps.length).toBe(3);
  });

  it('does not touch a cooking session or its snapshot', async () => {
    // The session holds the authority for what is being cooked right now.
    const { ctx, tables } = context({
      cooking_sessions: [
        {
          id: 'session-1',
          user_id: USER,
          recipe_id: 'recipe-old',
          recipe_snapshot: { title: '元のまま', steps: [] },
          current_step: 1,
          total_steps: 2,
          status: 'active',
        },
      ],
    });
    const source = await createRecipe(ctx, recipeInput());
    const snapshotBefore = JSON.stringify(tables.cooking_sessions);

    await reviseRecipe(ctx, source.id, dashiFromScratch());

    expect(JSON.stringify(tables.cooking_sessions)).toBe(snapshotBefore);
  });
});

describe('what a revision refuses to do', () => {
  it('will not revise a recipe belonging to someone else', async () => {
    const { ctx, tables } = context({
      recipes: [
        {
          id: 'someone-elses',
          user_id: 'user-2',
          title: '他人のレシピ',
          servings: 1,
          ingredients: [],
          steps: [],
          source_type: 'ai',
        },
      ],
    });
    const before = tables.recipes.length;

    await expect(reviseRecipe(ctx, 'someone-elses', dashiFromScratch())).rejects.toThrow(
      ServiceError,
    );
    expect(tables.recipes.length).toBe(before);
  });

  it('will not revise a recipe that does not exist', async () => {
    const { ctx, tables } = context();
    const before = tables.recipes.length;

    await expect(reviseRecipe(ctx, 'no-such-recipe', dashiFromScratch())).rejects.toThrow(
      ServiceError,
    );
    expect(tables.recipes.length).toBe(before);
  });

  it('writes no row when the revision fails validation', async () => {
    const { ctx, tables } = context();
    const source = await createRecipe(ctx, recipeInput());
    const before = tables.recipes.length;

    // A recipe with no steps is not a recipe.
    await expect(reviseRecipe(ctx, source.id, recipeInput({ steps: [] }))).rejects.toThrow();
    expect(tables.recipes.length).toBe(before);
  });

  it('checks ownership before writing anything', async () => {
    // Ordering matters: validating first and then failing the ownership check
    // would leave the new row behind.
    const { ctx, tables } = context();
    const before = tables.recipes.length;

    await expect(reviseRecipe(ctx, 'no-such-recipe', dashiFromScratch())).rejects.toThrow();
    expect(tables.recipes.length).toBe(before);
  });
});
