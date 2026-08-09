import OpenAI from 'openai';
import { describe, expect, it } from 'vitest';

import { buildSystemPrompt } from './prompt';
import { TOOL_DEFINITIONS } from './tools';

/**
 * Live check (not part of `npm test`): does the model actually call the
 * shopping tool, or does it answer from the inventory in the system prompt?
 *
 * This exists because it did the latter. On a device, 「肉じゃがのレシピを作って、
 * 必要なのに在庫にない食材を買い物リストの候補として提案して。」 produced a perfect
 * list of missing ingredients, told the user to pick from the card — and called
 * no tools at all. The prose was right and nothing was real.
 *
 * The inventory is in the system prompt (PHASE 4), so the model can always
 * answer "what am I missing" without help. Only a live check can show whether
 * the rules are strong enough to stop it.
 *
 * One turn, no history: this measures the prompt, not a contaminated
 * conversation.
 *
 * Run with: npm run test:live
 */

const INVENTORY = [
  { name: '鶏もも肉', quantity: 200, unit: 'g', daysLeft: 2 },
  { name: '醤油', quantity: 1, unit: '本', daysLeft: null },
  { name: '砂糖', quantity: 1, unit: '袋', daysLeft: null },
  { name: '料理酒', quantity: 1, unit: '本', daysLeft: null },
];

async function askOnce(message: string, mode: 'text' | 'voice' = 'text') {
  const apiKey = process.env.OPENAI_API_KEY;
  expect(apiKey, 'OPENAI_API_KEY must be set').toBeTruthy();

  const openai = new OpenAI({ apiKey, timeout: 45_000, maxRetries: 2 });
  const completion = await openai.chat.completions.create({
    model: process.env.OPENAI_MODEL || 'gpt-4.1',
    messages: [
      {
        role: 'system',
        content: buildSystemPrompt({
          profile: null,
          session: null,
          today: '2026-08-10',
          mode,
          inventory: INVENTORY,
        }),
      },
      { role: 'user', content: message },
    ],
    tools: TOOL_DEFINITIONS,
    tool_choice: 'auto',
    temperature: 0.4,
  });

  const choice = completion.choices[0]?.message;
  const calls = (choice?.tool_calls ?? []).flatMap((call) =>
    call.type === 'function' ? [call.function.name] : [],
  );

  return { calls, text: choice?.content ?? '' };
}

/** The exact phrasing that failed on the device. */
const DEVICE_PHRASING =
  '肉じゃがのレシピを作って、必要なのに在庫にない食材を買い物リストの候補として提案して。';

describe('the assistant reaches for the shopping tool', () => {
  it('starts a tool call rather than answering from the prompt inventory', async () => {
    const { calls, text } = await askOnce(DEVICE_PHRASING);

    // Either it makes the recipe first or it goes straight for candidates.
    // What it must not do is answer with prose and no tools at all.
    expect(calls, `answered with no tools: ${text.slice(0, 200)}`).not.toEqual([]);
  }, 60_000);

  it('does not promise a card in the same breath as calling no tools', async () => {
    const { calls, text } = await askOnce(DEVICE_PHRASING);

    // The harm is not the missing card; it is being told to use one that was
    // never drawn. If no tool ran, the reply must not send the user to it.
    if (calls.length === 0) {
      expect(text).not.toMatch(/カード/);
    }
  }, 60_000);

  it('asks for the shopping tool when the request is only about buying', async () => {
    const { calls, text } = await askOnce('肉じゃがを作りたい。何を買えばいい？');

    expect(calls, `answered with no tools: ${text.slice(0, 200)}`).not.toEqual([]);
  }, 60_000);

  it('sends the user to the screen rather than the card in voice mode', async () => {
    const { text } = await askOnce('肉じゃがを作るのに何を買えばいい？', 'voice');

    // Voice has the same tool but cannot draw a card.
    if (/カード/.test(text)) {
      expect(text, 'voice reply pointed at a card it cannot show').toBe('');
    }
  }, 60_000);
});
