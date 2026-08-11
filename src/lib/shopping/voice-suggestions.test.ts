import { describe, expect, it } from 'vitest';

import type { ShoppingSuggestion } from './suggest';
import {
  assistantMessage,
  hasSuggestionCard,
  withVoiceSuggestions,
  VOICE_SUGGESTION_CAPTION,
  type ChatMessage,
} from './chat-suggestions';

/**
 * PHASE 10 — voice QA 9 failed: the assistant read the candidates out and no
 * card appeared.
 *
 * The ledger showed the tool had run and had produced them, so nothing was
 * wrong with the candidates; `/api/realtime/tool` simply did not send them to
 * the browser. What is pinned here is the half that lives in the client: the
 * card is built from structured output, by the same helpers the text path
 * uses, and repeated delivery of one result does not stack copies.
 */

function suggestion(name: string): ShoppingSuggestion {
  return {
    name,
    reason: 'absent',
    reasonLabel: '在庫にない',
    quantity: null,
    unit: null,
    isStaple: false,
    alreadyOnList: false,
    sourceRecipes: [{ recipeId: 'r1', title: '肉じゃが' }],
  };
}

const spoken: ChatMessage = {
  id: 'spoken-1',
  role: 'assistant',
  // The exact sentence the device heard. It names the candidates, and it must
  // never be what draws a card.
  content: 'じゃがいも2個、にんじん1本、だし汁300mlです。追加は画面で候補を選んでください。',
};

describe('1 — a voice tool result lands in the same state as the text path', () => {
  it('produces a message the shared card rule accepts', () => {
    const [card] = withVoiceSuggestions([], 'call_1', [suggestion('じゃがいも'), suggestion('にんじん')]);

    expect(hasSuggestionCard(card)).toBe(true);
    expect(card.suggestions).toHaveLength(2);
    expect(card.role).toBe('assistant');
  });

  it('is identical to what the text path builds from the same candidates', () => {
    const candidates = [suggestion('じゃがいも'), suggestion('だし汁')];
    const [voice] = withVoiceSuggestions([], 'call_1', candidates);
    const text = assistantMessage(voice.id, {
      reply: VOICE_SUGGESTION_CAPTION,
      shoppingSuggestions: candidates,
    });

    expect(voice).toEqual(text);
  });

  it('captions the card with fixed text, not the assistant sentence', () => {
    const [card] = withVoiceSuggestions([], 'call_1', [suggestion('じゃがいも')]);

    expect(card.content).toBe(VOICE_SUGGESTION_CAPTION);
    expect(card.content).not.toContain('だし汁');
  });
});

describe('2-4 — nothing structured, nothing drawn', () => {
  it('draws no card for an empty candidate list', () => {
    expect(withVoiceSuggestions([], 'call_1', [])).toEqual([]);
  });

  it('leaves the transcript untouched when the list is empty', () => {
    const before = [spoken];
    expect(withVoiceSuggestions(before, 'call_1', [])).toBe(before);
  });

  it('draws no card when the field is missing or null', () => {
    // What the client receives when the route sends nothing. The guard lives
    // in the hook, so this pins the shape the helper must never be handed.
    const missing = undefined as ShoppingSuggestion[] | undefined;
    const nulled = null as ShoppingSuggestion[] | null;

    expect(withVoiceSuggestions([], 'call_1', missing ?? [])).toEqual([]);
    expect(withVoiceSuggestions([], 'call_1', nulled ?? [])).toEqual([]);
  });

  it('draws no card for a spoken reply that merely names candidates', () => {
    // The failing QA turn, minus the tool output. Prose alone is not a card.
    expect(hasSuggestionCard(spoken)).toBe(false);
    expect(withVoiceSuggestions([spoken], 'call_1', [])).toEqual([spoken]);
  });
});

describe('5-6 — repeated and multiple tool calls', () => {
  it('draws one card when the same result arrives twice', () => {
    // A retried relay, or the same response.done seen again.
    const once = withVoiceSuggestions([], 'call_1', [suggestion('じゃがいも')]);
    const twice = withVoiceSuggestions(once, 'call_1', [suggestion('じゃがいも')]);

    expect(twice.filter(hasSuggestionCard)).toHaveLength(1);
    expect(twice).toHaveLength(1);
  });

  it('replaces the card in place rather than appending a second', () => {
    const once = withVoiceSuggestions([], 'call_1', [suggestion('じゃがいも')]);
    const updated = withVoiceSuggestions(once, 'call_1', [
      suggestion('じゃがいも'),
      suggestion('にんじん'),
    ]);

    expect(updated).toHaveLength(1);
    expect(updated[0].suggestions).toHaveLength(2);
  });

  it('keeps both cards when two different calls return candidates', () => {
    const first = withVoiceSuggestions([], 'call_1', [suggestion('じゃがいも')]);
    const second = withVoiceSuggestions(first, 'call_2', [suggestion('だし汁')]);

    expect(second).toHaveLength(2);
    expect(second.flatMap((m) => m.suggestions ?? []).map((s) => s.name)).toEqual([
      'じゃがいも',
      'だし汁',
    ]);
  });

  it('keeps the spoken transcript around the cards', () => {
    const withCard = withVoiceSuggestions([spoken], 'call_1', [suggestion('じゃがいも')]);

    expect(withCard[0]).toBe(spoken);
    expect(hasSuggestionCard(withCard[1])).toBe(true);
  });
});
