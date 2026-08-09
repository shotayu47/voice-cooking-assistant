import { describe, expect, it } from 'vitest';

import { createFakeSupabase, type Row, type Tables } from '@/test/fake-supabase';
import type { ServiceContext } from '@/lib/inventory/service';

import { executeTool } from './tools';
import { buildSystemPrompt } from './prompt';

/**
 * PHASE 10 through the real tool dispatch.
 *
 * The pure tests prove which ingredients are missing. These prove the property
 * the whole design rests on: that asking for candidates writes nothing. If
 * this file ever goes green while a row appears in shopping_items, the
 * assistant has started doing the user's shopping for them.
 */

const USER_ID = 'user-1';
const OTHER_USER_ID = 'user-2';

const RECIPE_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_RECIPE_ID = '22222222-2222-4222-8222-222222222222';

function seedRecipe(overrides: Row = {}): Row {
  return {
    id: RECIPE_ID,
    user_id: USER_ID,
    title: '肉じゃが',
    description: null,
    servings: 2,
    estimated_minutes: 30,
    difficulty: 'easy',
    ingredients: [
      { name: 'じゃが芋', amount: 3, unit: '個', required: true },
      { name: '玉ねぎ', amount: 1, unit: '個', required: true },
      { name: '醤油', amount: 2, unit: '大さじ', required: true },
      { name: '絹さや', required: false },
    ],
    steps: [{ index: 0, instruction: '切る', ingredientRefs: [] }],
    source_type: 'ai',
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-01T00:00:00Z',
    ...overrides,
  };
}

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

function seedShoppingItem(name: string, overrides: Row = {}): Row {
  return {
    id: `shop-${name}`,
    user_id: USER_ID,
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

function setup(seed: Tables = {}): { ctx: ServiceContext; tables: Tables } {
  const { client, tables } = createFakeSupabase({
    recipes: [seedRecipe()],
    inventory_items: [],
    shopping_items: [],
    ...seed,
  });
  return { ctx: { supabase: client, userId: USER_ID }, tables };
}

const run = (ctx: ServiceContext, args: Record<string, unknown>) =>
  executeTool(ctx, 'suggest_shopping_items', JSON.stringify(args));

type SuggestionRow = {
  name: string;
  reason: string;
  quantity: number | null;
  unit: string | null;
  already_on_list: boolean;
  for_dishes: string[];
};

function suggestionsOf(result: unknown): SuggestionRow[] {
  return (result as { suggestions?: SuggestionRow[] }).suggestions ?? [];
}

describe('suggest_shopping_items — writes nothing', () => {
  it('leaves shopping_items untouched', async () => {
    const { ctx, tables } = setup({ shopping_items: [seedShoppingItem('牛乳')] });
    const before = JSON.stringify(tables.shopping_items);

    const outcome = await run(ctx, { recipe_ids: [RECIPE_ID], include_staples: null });

    expect(suggestionsOf(outcome.result).length).toBeGreaterThan(0);
    // The candidates exist and the list did not move.
    expect(JSON.stringify(tables.shopping_items)).toBe(before);
    expect(tables.shopping_items).toHaveLength(1);
  });

  it('leaves the inventory untouched', async () => {
    const { ctx, tables } = setup({ inventory_items: [seedInventoryItem('じゃが芋')] });
    const before = JSON.stringify(tables.inventory_items);

    await run(ctx, { recipe_ids: [RECIPE_ID], include_staples: null });

    expect(JSON.stringify(tables.inventory_items)).toBe(before);
  });

  it('reports that nothing was added, so the model does not claim otherwise', async () => {
    const { ctx } = setup();

    const outcome = await run(ctx, { recipe_ids: [RECIPE_ID], include_staples: null });

    expect((outcome.result as { added: boolean }).added).toBe(false);
    expect((outcome.result as { note: string }).note).toContain('まだ何も追加していません');
  });

  it('does not mark the turn as an inventory change', async () => {
    const { ctx } = setup();

    const outcome = await run(ctx, { recipe_ids: [RECIPE_ID], include_staples: null });

    expect(outcome.effect).toBeUndefined();
  });
});

describe('suggest_shopping_items — the server decides', () => {
  it('proposes the required ingredients that are missing', async () => {
    const { ctx } = setup({ inventory_items: [seedInventoryItem('じゃが芋')] });

    const outcome = await run(ctx, { recipe_ids: [RECIPE_ID], include_staples: null });

    // じゃが芋 is in the fridge, 醤油 is a staple, 絹さや is optional.
    expect(suggestionsOf(outcome.result).map((entry) => entry.name)).toEqual(['玉ねぎ']);
  });

  it("carries the recipe's own amounts", async () => {
    const { ctx } = setup();

    const outcome = await run(ctx, { recipe_ids: [RECIPE_ID], include_staples: null });
    const potato = suggestionsOf(outcome.result).find((entry) => entry.name === 'じゃが芋');

    expect(potato).toMatchObject({ quantity: 3, unit: '個' });
  });

  it('flags an item that is already on the list without hiding it', async () => {
    const { ctx } = setup({ shopping_items: [seedShoppingItem('たまねぎ')] });

    const outcome = await run(ctx, { recipe_ids: [RECIPE_ID], include_staples: null });
    const onion = suggestionsOf(outcome.result).find((entry) => entry.name === '玉ねぎ');

    expect(onion?.already_on_list).toBe(true);
  });

  it('includes staples only when asked', async () => {
    const { ctx } = setup();

    const without = await run(ctx, { recipe_ids: [RECIPE_ID], include_staples: null });
    const withStaples = await run(ctx, { recipe_ids: [RECIPE_ID], include_staples: true });

    expect(suggestionsOf(without.result).map((e) => e.name)).not.toContain('醤油');
    expect(suggestionsOf(withStaples.result).map((e) => e.name)).toContain('醤油');
  });

  it('names the dish each candidate came from', async () => {
    const { ctx } = setup();

    const outcome = await run(ctx, { recipe_ids: [RECIPE_ID], include_staples: null });

    expect(suggestionsOf(outcome.result)[0].for_dishes).toEqual(['肉じゃが']);
  });
});

describe('suggest_shopping_items — what the model may not do', () => {
  it("cannot read another user's recipe", async () => {
    const { ctx } = setup({
      recipes: [seedRecipe({ id: OTHER_RECIPE_ID, user_id: OTHER_USER_ID })],
    });

    const outcome = await run(ctx, { recipe_ids: [OTHER_RECIPE_ID], include_staples: null });

    expect((outcome.result as { error?: string }).error).toBe('recipes_not_found');
    expect(suggestionsOf(outcome.result)).toEqual([]);
  });

  it('rejects ids that are not uuids rather than querying with them', async () => {
    const { ctx } = setup();

    const outcome = await run(ctx, {
      recipe_ids: ['肉じゃが', '', 'or 1=1'],
      include_staples: null,
    });

    expect((outcome.result as { error?: string }).error).toBe('no_recipes');
  });

  it('asks for a recipe when given none', async () => {
    const { ctx } = setup();

    expect(
      ((await run(ctx, { recipe_ids: [], include_staples: null })).result as { error?: string })
        .error,
    ).toBe('no_recipes');
    expect(
      ((await run(ctx, { recipe_ids: null, include_staples: null })).result as { error?: string })
        .error,
    ).toBe('no_recipes');
  });

  it('cannot supply its own ingredient names', async () => {
    // There is no argument for them: the only input is a recipe id, so a
    // hallucinated ingredient has no way into the result.
    const { ctx } = setup();

    const outcome = await run(ctx, {
      recipe_ids: [RECIPE_ID],
      include_staples: null,
      // Ignored — not part of the schema.
      items: ['キャビア'],
    });

    expect(suggestionsOf(outcome.result).map((entry) => entry.name)).not.toContain('キャビア');
  });
});

describe('shopping suggestion prompt rules', () => {
  const prompt = buildSystemPrompt({
    profile: null,
    session: null,
    today: '2026-08-10',
    mode: 'text',
  });

  it('tells the model the tool adds nothing', () => {
    expect(prompt).toContain('買い物リストに何も追加しません');
    expect(prompt).toContain('「追加しました」');
  });

  it('tells the model the candidates are temporary', () => {
    // The card is gone after a reload; the assistant's text is what remains.
    expect(prompt).toContain('一時的な結果');
    expect(prompt).toContain('再読み込み');
  });

  it('keeps the PHASE 9 rule that an existing line is a warning, not a veto', () => {
    expect(prompt).toContain('すでにリストにあります');
    expect(prompt).toContain('追加できないわけではありません');
  });

  it('applies outside a cooking session too', () => {
    expect(prompt).toContain('【買い物候補】');
  });
});

describe('voice mode', () => {
  const voice = buildSystemPrompt({
    profile: null,
    session: null,
    today: '2026-08-10',
    mode: 'voice',
  });
  const text = buildSystemPrompt({
    profile: null,
    session: null,
    today: '2026-08-10',
    mode: 'text',
  });

  it('tells the model the card cannot be operated by voice', () => {
    // The tool is offered in both modes (SPEC §21.1 parity) and writes nothing
    // in either. What voice lacks is the pickable card.
    expect(voice).toContain('音声では候補カードを操作できません');
    expect(voice).toContain('追加は画面で候補を選んでください');
  });

  it('does not add the voice-only wording to text mode', () => {
    expect(text).not.toContain('【音声での買い物候補】');
  });

  it('keeps the shared rules in both modes', () => {
    expect(voice).toContain('【買い物候補】');
    expect(text).toContain('【買い物候補】');
  });
});

describe('the rule that stops a card being promised out of thin air', () => {
  const prompt = buildSystemPrompt({
    profile: null,
    session: null,
    today: '2026-08-10',
    mode: 'text',
  });

  it('makes the tool call obligatory for this intent', () => {
    // The device failure: the model answered 「不足している食材」 from the
    // inventory already in the prompt, called nothing, and still sent the user
    // to a card. The prose was right and none of it was real.
    expect(prompt).toContain('必ず');
    expect(prompt).toContain('ツールを呼ばずに「不足している食材」を列挙しないでください');
  });

  it('ties any mention of the card to having actually called the tool', () => {
    expect(prompt).toContain(
      '画面のカードに触れてよいのは、suggest_shopping_items を実際に呼んで結果が',
    );
  });

  it('tells it what to say when there is genuinely nothing to buy', () => {
    // Otherwise a 0-candidate result invites it to invent a list instead.
    expect(prompt).toContain('買い足すものはありません');
  });
});
