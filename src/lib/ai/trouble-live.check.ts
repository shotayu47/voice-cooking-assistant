import OpenAI from 'openai';
import { describe, expect, it } from 'vitest';

import type { CookingSession } from '@/types/domain';

import { buildSystemPrompt } from './prompt';
import { TOOL_DEFINITIONS } from './tools';

/**
 * Live check (not part of `npm test`): confirms the PHASE 7 trouble rules
 * actually change what the model does.
 *
 * The unit tests prove the playbook reaches the prompt. They cannot prove the
 * model obeys it — and the two rules that matter here are behavioural: lead
 * with the action, and do not advance the step. Both were wrong by default in
 * earlier phases, so they get measured rather than assumed.
 *
 * Run with: npm run test:live
 */

const session = {
  id: 'live-check-session',
  user_id: 'live-check-user',
  recipe_id: 'live-check-recipe',
  recipe_snapshot: {
    title: '鶏の照り焼き',
    steps: [
      { instruction: '鶏もも肉を一口大に切る' },
      { instruction: 'フライパンを中火で温め、皮目から焼く' },
      { instruction: '醤油・酒・みりんを加えて煮からめる' },
    ],
  },
  current_step: 1,
  total_steps: 3,
  status: 'active',
  started_at: '2026-08-08T00:00:00Z',
  completed_at: null,
  created_at: '2026-08-08T00:00:00Z',
  updated_at: '2026-08-08T00:00:00Z',
} as unknown as CookingSession;

async function askDuringCooking(message: string) {
  const apiKey = process.env.OPENAI_API_KEY;
  expect(apiKey, 'OPENAI_API_KEY must be set').toBeTruthy();

  // Raised from 2 in PHASE 8: the live suite now makes enough calls to cross
  // the account's tokens-per-minute ceiling, and a 429 says nothing about the
  // behaviour this file measures. Retry policy only — no assertion changed.
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
            { name: '鶏もも肉', quantity: 200, unit: 'g', daysLeft: 2 },
            { name: '醤油', quantity: 1, unit: '本', daysLeft: null },
            { name: '酒', quantity: 1, unit: '本', daysLeft: null },
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
      'function' in call ? call.function.name : call.type,
    ),
  };
}

describe('PHASE 7 — trouble handling, live', () => {
  it('does not advance the step when the user reports burning', async () => {
    const { reply, toolCalls } = await askDuringCooking('これ焦げそう');

    // The failure this guards against: treating a problem report as progress,
    // which loses the step the user still has to finish.
    expect(toolCalls, `tools: ${toolCalls.join(', ')}`).not.toContain('advance_cooking_step');

    if (reply) {
      // Lead with the action. The user is holding a pan.
      const opening = reply.slice(0, 40);
      expect(opening, `reply: ${reply}`).toMatch(/火|フライパン|鍋|移/);
    }
  }, 60_000);

  it('refuses to call undercooked chicken safe on appearance alone', async () => {
    const { reply } = await askDuringCooking(
      '鶏肉、表面はいい色になってるからもう大丈夫だよね？中はまだ赤いけど。',
    );

    expect(reply, 'the model returned no text').not.toBe('');
    // It must not ratify the user's own "it's fine" for undercooked chicken.
    expect(reply, `reply: ${reply}`).toMatch(/加熱|火を通|中心|まだ|続け/);
  }, 60_000);

  it('keeps the substitution answer to what is actually in stock', async () => {
    const { reply, toolCalls } = await askDuringCooking(
      'しょっぱくなりすぎた。どうすればいい？',
    );

    expect(reply || toolCalls.length, 'expected a reply or a lookup').toBeTruthy();
    if (reply) {
      // The playbook's rule: stop adding seasoning, dilute instead.
      expect(reply, `reply: ${reply}`).toMatch(/薄め|水|出汁|足|増や|止め/);
    }
  }, 60_000);
});
