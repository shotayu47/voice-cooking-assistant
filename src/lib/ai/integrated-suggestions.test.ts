import { describe, expect, it, vi } from 'vitest';

import { createFakeSupabase, type Row, type Tables } from '@/test/fake-supabase';
import type { ServiceContext } from '@/lib/inventory/service';
import { recipeIngredientSchema } from '@/lib/recipes/schemas';

import { executeTool, realtimeToolDefinitions, TOOL_DEFINITIONS } from './tools';
import { buildSystemPrompt } from './prompt';

/**
 * Candidates folded into the recipe tool that produced the recipe.
 *
 * The flow this exists for — "レシピを作って、足りない材料も教えて" — cost three
 * Realtime responses, and the token allowance is what runs out first. Folding
 * the candidates into `create_recipe`'s own result removes the middle one.
 *
 * What must survive the change is everything PHASE 10 rests on: the recipe is
 * saved once, nothing is written to `shopping_items` or `inventory_items`, and
 * a failure to work out the candidates is not allowed to look like a failure to
 * save the recipe — because a model that sees `create_recipe` fail creates the
 * recipe again.
 */

const USER_ID = 'user-1';
const SOURCE_RECIPE_ID = '11111111-1111-4111-8111-111111111111';

function seedInventoryItem(name: string, overrides: Row = {}): Row {
  return {
    id: `inv-${name}`,
    user_id: USER_ID,
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

/** The original 味噌汁, the one the device QA revised away from 顆粒だし. */
function seedSourceRecipe(overrides: Row = {}): Row {
  return {
    id: SOURCE_RECIPE_ID,
    user_id: USER_ID,
    title: 'シンプルな卵と玉ねぎの味噌汁',
    description: null,
    servings: 2,
    estimated_minutes: 15,
    difficulty: 'easy',
    ingredients: [
      { name: '卵', amount: 2, unit: '個', required: true },
      { name: '玉ねぎ', amount: 1, unit: '個', required: true },
      { name: '顆粒だし', amount: 1, unit: '小さじ', required: true },
    ],
    steps: [{ index: 0, instruction: '切る', ingredientRefs: [] }],
    source_type: 'ai',
    created_at: '2026-08-16T21:09:08.748743Z',
    updated_at: '2026-08-16T21:09:08.748743Z',
    ...overrides,
  };
}

function setup(seed: Tables = {}): { ctx: ServiceContext; tables: Tables } {
  const { client, tables } = createFakeSupabase({
    recipes: [],
    inventory_items: [],
    shopping_items: [],
    ...seed,
  });
  return { ctx: { supabase: client, userId: USER_ID }, tables };
}

function recipeArgs(overrides: Record<string, unknown> = {}) {
  return {
    title: '肉じゃが',
    description: null,
    servings: 2,
    estimated_minutes: 30,
    difficulty: 'easy',
    ingredients: [
      { name: 'じゃが芋', amount: 3, unit: '個', required: true, substitute_options: null },
      { name: '玉ねぎ', amount: 1, unit: '個', required: true, substitute_options: null },
      { name: '絹さや', amount: null, unit: null, required: false, substitute_options: null },
    ],
    steps: [
      {
        instruction: 'じゃが芋を切る',
        duration_seconds: null,
        heat_value: null,
        heat_label: null,
        ingredient_refs: null,
        safety_note: null,
      },
    ],
    shopping_suggestions_mode: 'missing_only',
    ...overrides,
  };
}

const create = (ctx: ServiceContext, args: Record<string, unknown>) =>
  executeTool(ctx, 'create_recipe', JSON.stringify(args));

const revise = (ctx: ServiceContext, args: Record<string, unknown>) =>
  executeTool(ctx, 'revise_recipe', JSON.stringify(args));

type IntegratedResult = {
  recipe_id?: string;
  supersedes_recipe_id?: string;
  shopping_suggestions_handled?: boolean;
  shopping_suggestions?: {
    status: string;
    suggestions?: { name: string; already_on_list: boolean; for_dishes: string[] }[];
    added?: boolean;
    note?: string;
    message?: string;
    retry_hint?: string;
  };
};

const integrated = (result: unknown) => result as IntegratedResult;

describe('create_recipe with shopping_suggestions_mode', () => {
  it('saves one recipe and returns its candidates in the same result', async () => {
    const { ctx, tables } = setup({ inventory_items: [seedInventoryItem('じゃが芋')] });

    const outcome = await create(ctx, recipeArgs());
    const result = integrated(outcome.result);

    expect(tables.recipes).toHaveLength(1);
    expect(result.recipe_id).toBe(tables.recipes[0].id);
    expect(result.shopping_suggestions?.status).toBe('ok');
    // じゃが芋 is in the fridge; 絹さや is optional and never proposed.
    expect(result.shopping_suggestions?.suggestions?.map((entry) => entry.name)).toEqual([
      '玉ねぎ',
    ]);
    // The card is drawn from this, not from the model-facing copy above.
    expect(outcome.suggestions?.map((entry) => entry.name)).toEqual(['玉ねぎ']);
  });

  it('writes nothing to shopping_items or inventory_items', async () => {
    const { ctx, tables } = setup({ inventory_items: [seedInventoryItem('玉ねぎ')] });
    const shoppingBefore = JSON.stringify(tables.shopping_items);
    const inventoryBefore = JSON.stringify(tables.inventory_items);

    const outcome = await create(ctx, recipeArgs());

    expect(integrated(outcome.result).shopping_suggestions?.suggestions?.length).toBeGreaterThan(0);
    expect(JSON.stringify(tables.shopping_items)).toBe(shoppingBefore);
    expect(JSON.stringify(tables.inventory_items)).toBe(inventoryBefore);
    expect(tables.shopping_items).toHaveLength(0);
  });

  it('still tells the model that proposing is not adding', async () => {
    const { ctx } = setup();

    const result = integrated((await create(ctx, recipeArgs())).result);

    expect(result.shopping_suggestions?.added).toBe(false);
    expect(result.shopping_suggestions?.note).toContain('まだ何も追加していません');
  });

  it('does not mark the turn as an inventory change', async () => {
    const { ctx } = setup();

    expect((await create(ctx, recipeArgs())).effect).toBeUndefined();
  });
});

describe('create_recipe with shopping_suggestions_mode none', () => {
  it('saves the recipe and returns no candidates at all', async () => {
    const { ctx, tables } = setup();

    const outcome = await create(ctx, recipeArgs({ shopping_suggestions_mode: 'none' }));
    const result = integrated(outcome.result);

    expect(tables.recipes).toHaveLength(1);
    expect(result.recipe_id).toBe(tables.recipes[0].id);
    expect(result.shopping_suggestions).toBeUndefined();
    // No marker: the client keeps the ordinary continuation, which is what
    // leaves the model free to reach for another tool.
    expect(result.shopping_suggestions_handled).toBeUndefined();
    expect(outcome.suggestions).toBeUndefined();
  });

  it('treats a missing or unreadable mode as none', async () => {
    const { ctx } = setup();
    const args = recipeArgs();
    delete (args as Record<string, unknown>).shopping_suggestions_mode;

    const outcome = await create(ctx, args);

    expect(integrated(outcome.result).shopping_suggestions_handled).toBeUndefined();
    expect(outcome.suggestions).toBeUndefined();
  });
});

describe('revise_recipe with shopping_suggestions_mode', () => {
  const revisionArgs = recipeArgs({
    source_recipe_id: SOURCE_RECIPE_ID,
    title: 'シンプルな卵と玉ねぎの味噌汁（昆布とかつお節でだしを取る）',
    ingredients: [
      { name: '卵', amount: 2, unit: '個', required: true, substitute_options: null },
      { name: '玉ねぎ', amount: 1, unit: '個', required: true, substitute_options: null },
      { name: '昆布', amount: 5, unit: 'g', required: true, substitute_options: null },
      { name: 'かつお節', amount: 10, unit: 'g', required: true, substitute_options: null },
    ],
  });

  it('adds one revision, leaves the original untouched, and keeps the lineage id', async () => {
    const { ctx, tables } = setup({ recipes: [seedSourceRecipe()] });
    const originalBefore = JSON.stringify(tables.recipes[0]);

    const outcome = await revise(ctx, revisionArgs);
    const result = integrated(outcome.result);

    expect(tables.recipes).toHaveLength(2);
    // Not edited in place: same row, same updated_at, still 顆粒だし.
    expect(JSON.stringify(tables.recipes.find((row) => row.id === SOURCE_RECIPE_ID))).toBe(
      originalBefore,
    );
    expect(result.supersedes_recipe_id).toBe(SOURCE_RECIPE_ID);
    expect(result.recipe_id).not.toBe(SOURCE_RECIPE_ID);
  });

  it('computes the candidates from the new version, not the one being replaced', async () => {
    const { ctx } = setup({ recipes: [seedSourceRecipe()] });

    const outcome = await revise(ctx, revisionArgs);
    const names = outcome.suggestions?.map((entry) => entry.name) ?? [];

    expect(names).toContain('昆布');
    expect(names).toContain('かつお節');
    // The ingredient the revision removed must not come back as a candidate.
    expect(names).not.toContain('顆粒だし');
  });

  it('attributes every candidate to the new recipe id, so the card replaces the old one', async () => {
    const { ctx } = setup({ recipes: [seedSourceRecipe()] });

    const outcome = await revise(ctx, revisionArgs);
    const newRecipeId = integrated(outcome.result).recipe_id;
    const sourceIds = (outcome.suggestions ?? []).flatMap((entry) =>
      entry.sourceRecipes.map((source) => source.recipeId),
    );

    // `card-lineage` walks these ids back through `supersedes_recipe_id`. If a
    // candidate were attributed to the old recipe the chain would not resolve.
    expect(sourceIds.every((id) => id === newRecipeId)).toBe(true);
    expect(sourceIds.length).toBeGreaterThan(0);
  });

  it('writes nothing to shopping_items or inventory_items', async () => {
    const { ctx, tables } = setup({
      recipes: [seedSourceRecipe()],
      inventory_items: [seedInventoryItem('卵')],
    });
    const shoppingBefore = JSON.stringify(tables.shopping_items);
    const inventoryBefore = JSON.stringify(tables.inventory_items);

    await revise(ctx, revisionArgs);

    expect(JSON.stringify(tables.shopping_items)).toBe(shoppingBefore);
    expect(JSON.stringify(tables.inventory_items)).toBe(inventoryBefore);
  });

  it('fails without writing a row when the source recipe is not the caller’s', async () => {
    const { ctx, tables } = setup({ recipes: [] });

    const outcome = await revise(ctx, revisionArgs);

    expect(tables.recipes).toHaveLength(0);
    expect((outcome.result as { error?: string }).error).toBeDefined();
    expect(integrated(outcome.result).shopping_suggestions_handled).toBeUndefined();
  });
});

describe('no candidates is not a failure', () => {
  it('completes with an empty list and no card when everything is in stock', async () => {
    const { ctx, tables } = setup({
      inventory_items: [seedInventoryItem('じゃが芋'), seedInventoryItem('玉ねぎ')],
    });

    const outcome = await create(ctx, recipeArgs());
    const result = integrated(outcome.result);

    expect(tables.recipes).toHaveLength(1);
    // `empty` rather than `ok`: nothing to buy is its own answer, and it is
    // the one the model is told to say out loud.
    expect(result.shopping_suggestions?.status).toBe('empty');
    expect(result.shopping_suggestions?.suggestions).toEqual([]);
    // Empty, not absent: the client draws a card only for a non-empty list, so
    // this is what "no card" looks like on the wire.
    expect(outcome.suggestions).toEqual([]);
    // The reply still has to happen — the marker is what asks for it.
    expect(result.shopping_suggestions_handled).toBe(true);
  });
});

describe('a failed suggestion is not a failed recipe', () => {
  /** Lets the recipe insert succeed and breaks the read the candidates need. */
  function brokenInventoryRead() {
    const { ctx, tables } = setup();
    const from = ctx.supabase.from.bind(ctx.supabase);

    vi.spyOn(ctx.supabase, 'from').mockImplementation(((table: string) => {
      if (table === 'inventory_items') throw new Error('connection terminated unexpectedly');
      return from(table);
    }) as typeof ctx.supabase.from);

    return { ctx, tables };
  }

  it('keeps the recipe, reports the candidates as failed, and creates nothing twice', async () => {
    const { ctx, tables } = brokenInventoryRead();

    const outcome = await create(ctx, recipeArgs());
    const result = integrated(outcome.result);

    // The row is there and there is exactly one of it.
    expect(tables.recipes).toHaveLength(1);
    expect(result.recipe_id).toBe(tables.recipes[0].id);
    // Not an error result: `error` is what would send the model back to
    // create_recipe for a second attempt at the same dish.
    expect((outcome.result as { error?: string }).error).toBeUndefined();
    expect(result.shopping_suggestions?.status).toBe('failed');
    expect(outcome.suggestions).toBeUndefined();
  });

  it('says the recipe was saved and tells the model not to redo it this turn', async () => {
    const { ctx } = brokenInventoryRead();

    const result = integrated((await create(ctx, recipeArgs())).result);

    expect(result.shopping_suggestions?.message).toContain('レシピは保存できました');
    expect(result.shopping_suggestions?.retry_hint).toContain('作り直さないでください');
    expect(result.shopping_suggestions?.retry_hint).toContain('suggest_shopping_items');
  });

  it('leaks nothing about why it failed', async () => {
    const { ctx } = brokenInventoryRead();

    const serialised = JSON.stringify((await create(ctx, recipeArgs())).result);

    expect(serialised).not.toContain('connection terminated');
    expect(serialised).not.toContain('inventory_items');
    expect(serialised).not.toContain('Error');
  });

  it('still asks for the closing reply', async () => {
    const { ctx } = brokenInventoryRead();

    // Without the marker the turn would fall back to an ordinary continuation
    // and the model could try `suggest_shopping_items` against a database that
    // is currently unreachable.
    expect(integrated((await create(ctx, recipeArgs())).result).shopping_suggestions_handled)
      .toBe(true);
  });
});

describe('the standalone tool is unchanged', () => {
  it('still answers a recipe id with candidates and writes nothing', async () => {
    const { ctx, tables } = setup({ recipes: [seedSourceRecipe()] });

    const outcome = await executeTool(
      ctx,
      'suggest_shopping_items',
      JSON.stringify({ recipe_ids: [SOURCE_RECIPE_ID], include_staples: null }),
    );
    const result = outcome.result as { suggestions: { name: string }[]; added: boolean };

    expect(result.suggestions.map((entry) => entry.name)).toContain('卵');
    expect(result.added).toBe(false);
    expect(outcome.suggestions?.length).toBeGreaterThan(0);
    expect(tables.shopping_items).toHaveLength(0);
  });

  it('still honours include_staples, which the folded path does not offer', async () => {
    const { ctx } = setup({
      recipes: [
        seedSourceRecipe({
          ingredients: [
            { name: '卵', amount: 2, unit: '個', required: true },
            { name: '味噌', amount: 2, unit: '大さじ', required: true },
          ],
        }),
      ],
    });

    const without = await executeTool(
      ctx,
      'suggest_shopping_items',
      JSON.stringify({ recipe_ids: [SOURCE_RECIPE_ID], include_staples: null }),
    );
    const withStaples = await executeTool(
      ctx,
      'suggest_shopping_items',
      JSON.stringify({ recipe_ids: [SOURCE_RECIPE_ID], include_staples: true }),
    );

    expect(without.suggestions?.map((entry) => entry.name)).not.toContain('味噌');
    expect(withStaples.suggestions?.map((entry) => entry.name)).toContain('味噌');
  });
});

describe('the modes agree with the standalone tool', () => {
  /** A recipe whose required list mixes an ordinary ingredient with a staple. */
  const withStaple = {
    ingredients: [
      { name: 'じゃが芋', amount: 3, unit: '個', required: true, substitute_options: null },
      { name: '醤油', amount: 2, unit: '大さじ', required: true, substitute_options: null },
    ],
  };

  /** Runs the standalone tool against whatever the folded call just saved. */
  async function standaloneFor(ctx: ServiceContext, recipeId: string, includeStaples: boolean) {
    const outcome = await executeTool(
      ctx,
      'suggest_shopping_items',
      JSON.stringify({ recipe_ids: [recipeId], include_staples: includeStaples }),
    );
    return (outcome.result as { suggestions: { name: string }[] }).suggestions.map((e) => e.name);
  }

  it('missing_only matches include_staples: false', async () => {
    const { ctx } = setup();

    const outcome = await create(
      ctx,
      recipeArgs({ ...withStaple, shopping_suggestions_mode: 'missing_only' }),
    );
    const folded = integrated(outcome.result).shopping_suggestions?.suggestions?.map((e) => e.name);

    expect(folded).toEqual(await standaloneFor(ctx, integrated(outcome.result).recipe_id!, false));
    expect(folded).toEqual(['じゃが芋']);
  });

  it('include_staples matches include_staples: true', async () => {
    const { ctx } = setup();

    const outcome = await create(
      ctx,
      recipeArgs({ ...withStaple, shopping_suggestions_mode: 'include_staples' }),
    );
    const folded = integrated(outcome.result).shopping_suggestions?.suggestions?.map((e) => e.name);

    expect(folded).toEqual(await standaloneFor(ctx, integrated(outcome.result).recipe_id!, true));
    expect(folded).toContain('醤油');
  });

  it('is the difference between the two modes, and only that', async () => {
    const { ctx } = setup();

    const missing = await create(
      ctx,
      recipeArgs({ ...withStaple, shopping_suggestions_mode: 'missing_only' }),
    );
    const staples = await create(
      ctx,
      recipeArgs({ ...withStaple, title: '肉じゃが2', shopping_suggestions_mode: 'include_staples' }),
    );

    expect(missing.suggestions?.map((e) => e.name)).not.toContain('醤油');
    expect(staples.suggestions?.map((e) => e.name)).toContain('醤油');
  });
});

describe('asking again for a different mode adds no row', () => {
  /**
   * The other half of the client's repeat guard.
   *
   * When the same recipe is asked for twice with different candidate modes,
   * the client does not run the recipe tool again — it reads candidates for
   * the id the first call produced. This is that read, and what it must leave
   * alone: the recipe table, the shopping list, and the inventory.
   */
  async function reuseRead(ctx: ServiceContext, recipeId: string, includeStaples: boolean) {
    return executeTool(
      ctx,
      'suggest_shopping_items',
      JSON.stringify({ recipe_ids: [recipeId], include_staples: includeStaples }),
    );
  }

  it('goes none → missing_only on one recipe row', async () => {
    const { ctx, tables } = setup();

    const created = await create(ctx, recipeArgs({ shopping_suggestions_mode: 'none' }));
    const recipeId = integrated(created.result).recipe_id!;
    expect(tables.recipes).toHaveLength(1);

    const reread = await reuseRead(ctx, recipeId, false);

    // Still one recipe, and the candidates are for the recipe that exists.
    expect(tables.recipes).toHaveLength(1);
    expect(tables.recipes[0].id).toBe(recipeId);
    expect(reread.suggestions?.length).toBeGreaterThan(0);
    expect(
      reread.suggestions?.every((entry) =>
        entry.sourceRecipes.every((source) => source.recipeId === recipeId),
      ),
    ).toBe(true);
  });

  it('goes missing_only → include_staples on one recipe row', async () => {
    const { ctx, tables } = setup();

    const created = await create(
      ctx,
      recipeArgs({
        shopping_suggestions_mode: 'missing_only',
        ingredients: [
          { name: 'じゃが芋', amount: 3, unit: '個', required: true, substitute_options: null },
          { name: '醤油', amount: 2, unit: '大さじ', required: true, substitute_options: null },
        ],
      }),
    );
    const recipeId = integrated(created.result).recipe_id!;

    expect(created.suggestions?.map((entry) => entry.name)).not.toContain('醤油');

    const reread = await reuseRead(ctx, recipeId, true);

    expect(tables.recipes).toHaveLength(1);
    expect(reread.suggestions?.map((entry) => entry.name)).toContain('醤油');
  });

  it('leaves a revision at one new row with the original untouched', async () => {
    const { ctx, tables } = setup({ recipes: [seedSourceRecipe()] });
    const originalBefore = JSON.stringify(tables.recipes[0]);

    const revised = await revise(
      ctx,
      recipeArgs({
        source_recipe_id: SOURCE_RECIPE_ID,
        title: '味噌汁（だしから）',
        shopping_suggestions_mode: 'none',
      }),
    );
    const newId = integrated(revised.result).recipe_id!;
    expect(tables.recipes).toHaveLength(2);

    await reuseRead(ctx, newId, false);

    // No third row, and the version being replaced is byte-for-byte as it was.
    expect(tables.recipes).toHaveLength(2);
    expect(JSON.stringify(tables.recipes.find((row) => row.id === SOURCE_RECIPE_ID))).toBe(
      originalBefore,
    );
  });

  it('writes nothing anywhere on the re-read', async () => {
    const { ctx, tables } = setup({ inventory_items: [seedInventoryItem('じゃが芋')] });

    const created = await create(ctx, recipeArgs({ shopping_suggestions_mode: 'none' }));
    const shoppingBefore = JSON.stringify(tables.shopping_items);
    const inventoryBefore = JSON.stringify(tables.inventory_items);

    await reuseRead(ctx, integrated(created.result).recipe_id!, true);

    expect(JSON.stringify(tables.shopping_items)).toBe(shoppingBefore);
    expect(JSON.stringify(tables.inventory_items)).toBe(inventoryBefore);
  });
});

describe('substitute_options is no longer asked for', () => {
  /**
   * The QA turn lost a whole response to this field.
   *
   * `substitute_options` was declared as an array of strings and the model
   * sent an array of objects, so `create_recipe` failed validation on
   * `ingredients.0.substituteOptions.0` and had to be retried. Nothing reads
   * the field — it is stored and never rendered — so it is no longer part of
   * what the model is asked to produce. The stored schema still allows it, and
   * recipes that already have it still load.
   */
  function ingredientSchemaOf(name: string) {
    const tool = TOOL_DEFINITIONS.find(
      (definition) => definition.type === 'function' && definition.function.name === name,
    );
    if (!tool || tool.type !== 'function') throw new Error(`${name} is not defined`);
    const params = tool.function.parameters as {
      properties: { ingredients: { items: { properties: Record<string, unknown>; required: string[] } } };
    };
    return params.properties.ingredients.items;
  }

  it.each(['create_recipe', 'revise_recipe'])('is absent from the %s schema', (name) => {
    const items = ingredientSchemaOf(name);

    expect(Object.keys(items.properties)).not.toContain('substitute_options');
    expect(items.required).not.toContain('substitute_options');
    // The fields that do matter are still all required.
    expect(items.required).toEqual(['name', 'amount', 'unit', 'required']);
  });

  it('is absent from the tools the voice session is given', () => {
    expect(JSON.stringify(realtimeToolDefinitions())).not.toContain('substitute_options');
  });

  it('saves exactly one recipe, and stores no substitutes', async () => {
    const { ctx, tables } = setup();

    await create(ctx, recipeArgs({ shopping_suggestions_mode: 'none' }));

    expect(tables.recipes).toHaveLength(1);
    const stored = tables.recipes[0].ingredients as Record<string, unknown>[];
    expect(stored.every((entry) => !('substituteOptions' in entry))).toBe(true);
  });

  it('saves a recipe even when the arguments carry the shape that used to fail', async () => {
    const { ctx, tables } = setup();

    // Exactly what the device sent: objects where strings were declared.
    const outcome = await create(
      ctx,
      recipeArgs({
        shopping_suggestions_mode: 'none',
        ingredients: [
          {
            name: 'じゃが芋',
            amount: 3,
            unit: '個',
            required: true,
            substitute_options: [{ name: 'さつまいも', note: '甘くなる' }],
          },
        ],
      }),
    );

    // No invalid_arguments, one row, and the objects reached nothing.
    expect((outcome.result as { error?: string }).error).toBeUndefined();
    expect(tables.recipes).toHaveLength(1);
    expect(JSON.stringify(tables.recipes[0].ingredients)).not.toContain('さつまいも');
    expect(JSON.stringify(tables.recipes[0].ingredients)).not.toContain('substituteOptions');
  });

  it('stores ingredients that still satisfy the persistence schema', async () => {
    const { ctx, tables } = setup();

    await create(ctx, recipeArgs({ shopping_suggestions_mode: 'none' }));

    for (const ingredient of tables.recipes[0].ingredients as unknown[]) {
      expect(recipeIngredientSchema.safeParse(ingredient).success).toBe(true);
    }
  });

  it('adds one revision without touching the original or copying its substitutes', async () => {
    const withSubstitutes = seedSourceRecipe({
      ingredients: [
        { name: '卵', amount: 2, unit: '個', required: true, substituteOptions: ['うずら卵'] },
        { name: '顆粒だし', amount: 1, unit: '小さじ', required: true },
      ],
    });
    const { ctx, tables } = setup({ recipes: [withSubstitutes] });
    const originalBefore = JSON.stringify(tables.recipes[0]);

    const outcome = await revise(
      ctx,
      recipeArgs({
        source_recipe_id: SOURCE_RECIPE_ID,
        title: '味噌汁（だしから）',
        shopping_suggestions_mode: 'none',
        ingredients: [
          { name: '卵', amount: 2, unit: '個', required: true },
          { name: '昆布', amount: 5, unit: 'g', required: true },
        ],
      }),
    );

    expect(tables.recipes).toHaveLength(2);
    // The original keeps its substitutes, byte for byte.
    expect(JSON.stringify(tables.recipes.find((row) => row.id === SOURCE_RECIPE_ID))).toBe(
      originalBefore,
    );
    // The new row does not inherit them — a revision is new input, not a patch.
    const revisedRow = tables.recipes.find(
      (row) => row.id === integrated(outcome.result).recipe_id,
    );
    expect(JSON.stringify(revisedRow?.ingredients)).not.toContain('うずら卵');
    expect(JSON.stringify(revisedRow?.ingredients)).not.toContain('substituteOptions');
  });

  it('still reads a recipe that was saved with substitutes before the change', async () => {
    const legacy = seedSourceRecipe({
      ingredients: [
        { name: '卵', amount: 2, unit: '個', required: true, substituteOptions: ['うずら卵'] },
        { name: '玉ねぎ', amount: 1, unit: '個', required: true },
      ],
    });
    const { ctx } = setup({ recipes: [legacy] });

    // Read back through a tool that walks the ingredients.
    const outcome = await executeTool(
      ctx,
      'suggest_shopping_items',
      JSON.stringify({ recipe_ids: [SOURCE_RECIPE_ID], include_staples: null }),
    );

    expect((outcome.result as { error?: string }).error).toBeUndefined();
    expect(outcome.suggestions?.map((entry) => entry.name)).toEqual(['卵', '玉ねぎ']);
    // And the stored row still parses under the schema that kept the field.
    for (const ingredient of legacy.ingredients as unknown[]) {
      expect(recipeIngredientSchema.safeParse(ingredient).success).toBe(true);
    }
  });
});

describe('the schema makes the model decide', () => {
  function schemaOf(name: string) {
    const tool = TOOL_DEFINITIONS.find(
      (definition) => definition.type === 'function' && definition.function.name === name,
    );
    if (!tool || tool.type !== 'function') throw new Error(`${name} is not defined`);
    return tool.function.parameters as {
      properties: Record<string, { type: string; enum?: string[]; description?: string }>;
      required: string[];
    };
  }

  it.each(['create_recipe', 'revise_recipe'])('requires the flag on %s', (name) => {
    const schema = schemaOf(name);

    // Required, not optional: whether the user asked for candidates is a
    // judgement about the request, and leaving it out would make silence the
    // answer. The app deliberately does not classify the utterance itself.
    expect(schema.required).toContain('shopping_suggestions_mode');
    expect(schema.properties.shopping_suggestions_mode.type).toBe('string');
    expect(schema.properties.shopping_suggestions_mode.enum).toEqual([
      'none',
      'missing_only',
      'include_staples',
    ]);
  });

  it.each(['create_recipe', 'revise_recipe'])('draws the boundary in the %s schema', (name) => {
    const description = schemaOf(name).properties.shopping_suggestions_mode.description ?? '';

    expect(description).toContain('none');
    expect(description).toContain('missing_only');
    expect(description).toContain('include_staples');
    expect(description).toContain('suggest_shopping_items');
  });

  it('still offers suggest_shopping_items on its own', () => {
    // The folded path covers a recipe being created or revised right now.
    // Candidates for a recipe that already exists still need this.
    const standalone = TOOL_DEFINITIONS.find(
      (definition) =>
        definition.type === 'function' && definition.function.name === 'suggest_shopping_items',
    );

    expect(standalone).toBeDefined();
    expect(TOOL_DEFINITIONS).toHaveLength(15);
  });
});

describe('when the prompt asks for an inventory tool call, and when it does not', () => {
  /**
   * The QA turn opened with `get_inventory`, which cost a whole response and
   * changed nothing: the voice instructions already carry 【現在の在庫】, and
   * the candidate computation reads the inventory server-side anyway.
   *
   * These pin the boundary in both directions. Narrowing "always check the
   * inventory" is only safe if the cases that genuinely need a fresh read
   * still say so — a stale answer to 「今いくつある?」 and an inventory write
   * made against a snapshot are both worse than a wasted response.
   */
  const voice = buildSystemPrompt({
    profile: null,
    session: null,
    today: '2026-08-17',
    mode: 'voice',
    inventory: [{ name: 'じゃがいも', quantity: 2, unit: '個', daysLeft: null }],
  });

  it('tells the model not to fetch the inventory first for a named dish', () => {
    expect(voice).toContain(
      '料理名を指定されてレシピを作る・変更するときは、先に get_inventory を呼ばないでください',
    );
    expect(voice).toContain('同じ発話で買い物候補も求められている場合も同じです');
  });

  it('says why: the server reads the inventory for the candidates', () => {
    expect(voice).toContain('不足材料の確定計算はサーバーが最新の在庫を読んで行う');
    expect(voice).toContain('応答が1回分増えるだけです');
  });

  it('points the model at the embedded snapshot for deciding recipe content', () => {
    expect(voice).toContain('レシピの内容は【現在の在庫】を見て決められます');
    expect(voice).toContain('【現在の在庫】');
  });

  it('still requires a tool call when asked about the inventory itself', () => {
    expect(voice).toContain('最新の在庫そのものを聞かれたら get_inventory を呼んでください');
    expect(voice).toContain('ユーザーが最新確認を求めたときも同様です');
  });

  it('still requires a tool call when the snapshot is unavailable', () => {
    expect(voice).toContain('【現在の在庫】が無いとき');
  });

  it('keeps the rules that guard an inventory write', () => {
    // Unchanged, and they must stay: a write decided from a snapshot is the
    // failure this app already fixed once.
    expect(voice).toContain('特定の食材を変更するときは find_inventory_item で item_id を特定');
    expect(voice).toContain('以前の get_inventory の結果から推測しないでください');
    expect(voice).toContain('needs_clarification が返ったら在庫は変更されていません');
    expect(voice).toContain('在庫を変更する前に必ずツールで最新を確認してください');
  });

  it('keeps the two-call search_meal_candidates route for 「今あるもので」', () => {
    expect(voice).toContain('search_meal_candidates を2回使ってください');
    expect(voice).toContain('1回目は candidates を null にして在庫を取得');
    expect(voice).toContain('mode: "fridge_cleanup"');
  });

  it('still forbids answering about the inventory from memory', () => {
    // The narrowing is about which *source* is acceptable, not about letting
    // the model guess.
    expect(voice).toContain('記憶や推測で答えないでください');
    expect(voice).toContain('根拠は【現在の在庫】かツール結果のどちらかです');
  });

  it('still forbids inventing the shortfall list, without demanding a fetch', () => {
    expect(voice).toContain('ツールを呼ばずに「不足している食材」を列挙しないでください');
    expect(voice).toContain('先に get_inventory を呼べという意味ではありません');
  });

  it('scopes "check the inventory first" to proposing a dish', () => {
    expect(voice).toContain('何を作るかをこちらから提案する前に、必ず在庫を確認してください');
    expect(voice).toContain('ユーザーが料理名を指定したときは提案ではない');
  });

  it('applies the same boundary in text mode', () => {
    // The snapshot is voice-only, but the rule about the server computing the
    // shortfall is not.
    const text = buildSystemPrompt({
      profile: null,
      session: null,
      today: '2026-08-17',
      mode: 'text',
    });

    expect(text).toContain('料理名を指定されてレシピを作る・変更するときは、先に get_inventory を呼ばないでください');
    expect(text).toContain('最新の在庫そのものを聞かれたら get_inventory を呼んでください');
  });
});

describe('the prompt draws the boundary between the two routes', () => {
  const prompt = buildSystemPrompt({
    profile: null,
    session: null,
    today: '2026-08-17',
    mode: 'voice',
  });

  it('sends a combined request through the flag', () => {
    expect(prompt).toContain('shopping_suggestions_mode');
    expect(prompt).toContain('そのあとに suggest_shopping_items を');
  });

  it('keeps the standalone tool for candidates on an existing recipe', () => {
    expect(prompt).toContain('すでにあるレシピの候補だけを求められたときは suggest_shopping_items');
    expect(prompt).toContain('候補のためだけにレシピを作り直さないでください');
  });

  it('tells the model a failed candidate does not mean a lost recipe', () => {
    expect(prompt).toContain('レシピは保存できています');
    expect(prompt).toContain('同じターンでレシピを作り直さないでください');
  });
});
