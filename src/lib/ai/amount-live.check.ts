import OpenAI from 'openai';
import { describe, expect, it } from 'vitest';

import type { CookingSession } from '@/types/domain';

import { buildSystemPrompt } from './prompt';
import { TOOL_DEFINITIONS } from './tools';

/**
 * Live check (not part of `npm test`): does the PHASE 8 rule actually change
 * what the model does?
 *
 * The unit tests prove the arithmetic is correct and that the rules reach the
 * prompt. They cannot prove the model stops doing the multiplication itself —
 * and doing it itself is the whole failure mode: a number nobody checked, and
 * a cooking time doubled along with the chicken.
 *
 * Run with: npm run test:live
 */

const RECIPE = {
  title: '鶏の照り焼き',
  servings: 2,
  ingredients: [
    { name: '鶏もも肉', amount: 300, unit: 'g', required: true },
    { name: '醤油', amount: 2, unit: '大さじ', required: true },
    { name: '卵', amount: 1, unit: '個', required: true },
    { name: '塩', required: true },
  ],
  steps: [
    { index: 0, instruction: '鶏もも肉を一口大に切る', ingredientRefs: ['鶏もも肉'] },
    {
      index: 1,
      instruction: 'フライパンを中火で温め、皮目から8分焼く',
      durationSeconds: 480,
    },
  ],
};

const session = {
  id: 'live-check-session',
  user_id: 'live-check-user',
  recipe_id: 'live-check-recipe',
  recipe_snapshot: RECIPE,
  current_step: 1,
  total_steps: 2,
  status: 'active',
  completed_steps: [0],
  skipped_steps: [],
  used_ingredients: [],
  started_at: '2026-08-08T00:00:00Z',
  completed_at: null,
  created_at: '2026-08-08T00:00:00Z',
  updated_at: '2026-08-08T00:00:00Z',
} as unknown as CookingSession;

async function askDuringCooking(message: string) {
  const apiKey = process.env.OPENAI_API_KEY;
  expect(apiKey, 'OPENAI_API_KEY must be set').toBeTruthy();

  // The whole live suite runs against a 30k TPM account ceiling, and a tool
  // loop is a lot of tokens in a short window. Back off through it rather than
  // failing a behavioural check on a rate limit.
  const openai = new OpenAI({ apiKey, timeout: 45_000, maxRetries: 5 });
  const completion = await openai.chat.completions.create({
    model: process.env.OPENAI_MODEL || 'gpt-4.1',
    messages: [
      {
        role: 'system',
        content: buildSystemPrompt({
          profile: null,
          session,
          today: '2026-08-08',
          mode: 'text',
          inventory: [
            { name: '鶏もも肉', quantity: 900, unit: 'g', daysLeft: 2 },
            { name: '醤油', quantity: 500, unit: 'ml', daysLeft: null },
            { name: '卵', quantity: 6, unit: '個', daysLeft: 10 },
          ],
        }),
      },
      { role: 'user', content: message },
    ],
    tools: TOOL_DEFINITIONS,
    tool_choice: 'auto',
    temperature: 0.4,
  });

  const choice = completion.choices[0]!.message;
  return {
    reply: choice.content ?? '',
    toolCalls: (choice.tool_calls ?? []).map((call) =>
      'function' in call
        ? { name: call.function.name, args: call.function.arguments }
        : { name: call.type, args: '' },
    ),
  };
}

describe('PHASE 8 — amount adjustment, live', () => {
  it('sends a servings change to the tool instead of multiplying in prose', async () => {
    const { reply, toolCalls } = await askDuringCooking('やっぱり4人分にしたい');

    const names = toolCalls.map((call) => call.name);
    expect(names, `tools: ${names.join(', ')} / reply: ${reply}`).toContain(
      'adjust_recipe_amounts',
    );

    const scale = toolCalls.find((call) => call.name === 'adjust_recipe_amounts');
    const args = JSON.parse(scale?.args || '{}');
    expect(args.mode).toBe('scale');
    expect(args.target_servings).toBe(4);
  }, 60_000);

  it('does not double the cooking time along with the ingredients', async () => {
    const { reply } = await askDuringCooking(
      '倍の量にしたら、8分焼くところは16分焼けばいい？',
    );

    if (reply) {
      // The failure this guards against: agreeing that twice the food takes
      // twice the time. It does not — and how much longer depends on the pan.
      expect(reply, `reply: ${reply}`).not.toMatch(/16分(で|に)(いい|なります|してください)/);
      expect(reply, `reply: ${reply}`).toMatch(/確認|様子|火の通り|厚み|鍋|フライパン|分けて/);
    }
  }, 60_000);

  it('asks the tool before claiming how many servings the fridge allows', async () => {
    const { reply, toolCalls } = await askDuringCooking('今ある鶏肉で何人分作れる？');

    const names = toolCalls.map((call) => call.name);
    expect(
      names.length,
      `answered with no tool call at all — reply: ${reply}`,
    ).toBeGreaterThan(0);

    const capacity = toolCalls.find((call) => call.name === 'adjust_recipe_amounts');
    if (capacity) {
      expect(JSON.parse(capacity.args || '{}').mode).toBe('max_from_inventory');
    }
  }, 60_000);

  it('keeps a fractional amount instead of silently rounding it', async () => {
    const { reply, toolCalls } = await askDuringCooking(
      '3人分にして。卵は何個いる？計算して教えて。',
    );

    const names = toolCalls.map((call) => call.name);
    if (names.includes('adjust_recipe_amounts')) return; // it deferred, which is the rule

    if (reply) {
      // 1個 for 2 servings, cooked for 3 → 1.5. Answering 「2個」 changes the
      // recipe by half an egg without saying so.
      expect(reply, `reply: ${reply}`).toMatch(/1\.5|1と1\/2|1個半|半分/);
    }
  }, 60_000);
});
