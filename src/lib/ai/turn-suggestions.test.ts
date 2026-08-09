import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createFakeSupabase, type Row, type Tables } from '@/test/fake-supabase';
import type { ServiceContext } from '@/lib/inventory/service';

/**
 * PHASE 10 — the candidates have to reach the browser.
 *
 * A device test failed with the assistant describing four missing ingredients
 * and telling the user to pick from a card that was never drawn. The tool
 * result reaching the *model* proves nothing about the structured result
 * reaching the *client*: they travel by different routes, and only one of them
 * was ever checked.
 *
 * These pin the client-facing route end to end, including the case that
 * actually happens — several tool calls across several iterations.
 */

const USER_ID = 'user-1';
const RECIPE_ID = '11111111-1111-4111-8111-111111111111';

/** Scripted assistant turns, consumed one per iteration of the tool loop. */
let turns: unknown[] = [];
const create = vi.fn(async () => ({ choices: [{ message: turns.shift() }] }));

vi.mock('./openai', () => ({
  CHAT_MODEL: 'test-model',
  getOpenAI: () => ({ chat: { completions: { create } } }),
}));

const { runTurn } = await import('./service');

function toolCall(id: string, name: string, args: unknown) {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

function seedRecipe(): Row {
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
    ],
    steps: [{ index: 0, instruction: '切る', ingredientRefs: [] }],
    source_type: 'ai',
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-01T00:00:00Z',
  };
}

function setup(): { ctx: ServiceContext; tables: Tables } {
  const { client, tables } = createFakeSupabase({
    profiles: [{ id: USER_ID, preferred_heat_scale: 'ih_10', cooking_skill_level: 'beginner' }],
    inventory_items: [],
    shopping_items: [],
    recipes: [seedRecipe()],
    conversation_sessions: [
      { id: 'conv-1', user_id: USER_ID, status: 'active', created_at: '2026-08-01T00:00:00Z' },
    ],
    conversation_messages: [],
    cooking_sessions: [],
  });
  return { ctx: { supabase: client, userId: USER_ID }, tables };
}

const ask = (ctx: ServiceContext) =>
  runTurn(ctx, { conversationId: 'conv-1', userMessage: '何を買えばいい？', cookingSessionId: null });

beforeEach(() => {
  turns = [];
  create.mockClear();
});

describe('A / E — suggestions survive the tool loop', () => {
  it('carries them out of a turn that also created a recipe', async () => {
    const { ctx } = setup();
    turns = [
      // Iteration 1: the model makes a recipe.
      { content: '', tool_calls: [toolCall('c1', 'create_recipe', {
        title: 'テスト料理',
        ingredients: [{ name: 'じゃが芋', required: true }],
        steps: [{ instruction: '切る' }],
      })] },
      // Iteration 2: then asks for candidates against the seeded recipe.
      { content: '', tool_calls: [toolCall('c2', 'suggest_shopping_items', {
        recipe_ids: [RECIPE_ID],
        include_staples: null,
      })] },
      // Iteration 3: prose, which is what ends the loop.
      { content: '候補を出しました。', tool_calls: [] },
    ];

    const result = await ask(ctx);

    expect(result.toolsUsed).toEqual(['create_recipe', 'suggest_shopping_items']);
    // The regression: a later iteration must not drop what an earlier one found.
    expect(result.shoppingSuggestions.map((entry) => entry.name)).toEqual(['じゃが芋', '玉ねぎ']);
  });

  it('keeps them when both calls arrive in one assistant turn', async () => {
    const { ctx } = setup();
    turns = [
      {
        content: '',
        tool_calls: [
          toolCall('c1', 'get_inventory', {}),
          toolCall('c2', 'suggest_shopping_items', { recipe_ids: [RECIPE_ID], include_staples: null }),
        ],
      },
      { content: 'どうぞ。', tool_calls: [] },
    ];

    const result = await ask(ctx);

    expect(result.shoppingSuggestions).toHaveLength(2);
  });

  it('is empty when the model never asked for candidates', async () => {
    // Exactly the device failure: prose, no tools. The field must be present
    // and empty rather than missing, so the client renders no card.
    const { ctx } = setup();
    turns = [{ content: 'じゃが芋と玉ねぎが足りません。', tool_calls: [] }];

    const result = await ask(ctx);

    expect(result.toolsUsed).toEqual([]);
    expect(result.shoppingSuggestions).toEqual([]);
  });

  it('is empty when the tool refused the arguments', async () => {
    const { ctx } = setup();
    turns = [
      { content: '', tool_calls: [toolCall('c1', 'suggest_shopping_items', {
        recipe_ids: ['not-a-uuid'],
        include_staples: null,
      })] },
      { content: 'レシピが要ります。', tool_calls: [] },
    ];

    const result = await ask(ctx);

    expect(result.shoppingSuggestions).toEqual([]);
  });
});

describe('B — the shape that goes over the wire', () => {
  it('survives JSON, with no Map, Set or undefined in it', async () => {
    const { ctx } = setup();
    turns = [
      { content: '', tool_calls: [toolCall('c1', 'suggest_shopping_items', {
        recipe_ids: [RECIPE_ID],
        include_staples: null,
      })] },
      { content: 'どうぞ。', tool_calls: [] },
    ];

    const result = await ask(ctx);

    // `NextResponse.json(result)` does exactly this.
    const overTheWire = JSON.parse(JSON.stringify(result));

    expect(Object.keys(overTheWire)).toContain('shoppingSuggestions');
    expect(overTheWire.shoppingSuggestions).toHaveLength(2);
    expect(overTheWire.shoppingSuggestions[0]).toMatchObject({
      name: 'じゃが芋',
      reason: 'absent',
      reasonLabel: '在庫にない',
      quantity: 3,
      unit: '個',
      alreadyOnList: false,
    });
    // sourceRecipes is an array of plain objects, not a Map or a Set.
    expect(Array.isArray(overTheWire.shoppingSuggestions[0].sourceRecipes)).toBe(true);
    expect(overTheWire.shoppingSuggestions[0].sourceRecipes[0]).toEqual({
      recipeId: RECIPE_ID,
      title: '肉じゃが',
    });
  });

  it('keeps the field even when there is nothing to send', async () => {
    const { ctx } = setup();
    turns = [{ content: 'ありません。', tool_calls: [] }];

    const overTheWire = JSON.parse(JSON.stringify(await ask(ctx)));

    expect(overTheWire.shoppingSuggestions).toEqual([]);
  });
});
