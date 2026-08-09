import { describe, expect, it } from 'vitest';

import type { ShoppingSuggestion } from './suggest';
import { assistantMessage, hasSuggestionCard } from './chat-suggestions';

/**
 * PHASE 10 — C and D of the transport checks.
 *
 * These cover the decision the chat makes about the card, not the DOM: the
 * project has no component-rendering setup, and adding one was out of scope.
 * So this pins "does this reply carry candidates, and does it draw a card",
 * and `SuggestionCard` itself returns null for an empty list.
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

describe('C — a reply with candidates draws a card', () => {
  it('attaches them to the assistant message', () => {
    const message = assistantMessage('reply-1', {
      reply: '候補を出しました。',
      shoppingSuggestions: [suggestion('玉ねぎ'), suggestion('じゃが芋')],
    });

    expect(message.suggestions).toHaveLength(2);
    expect(hasSuggestionCard(message)).toBe(true);
  });

  it('keeps the reply text alongside the card', () => {
    const message = assistantMessage('reply-1', {
      reply: '候補を出しました。',
      shoppingSuggestions: [suggestion('玉ねぎ')],
    });

    expect(message.content).toBe('候補を出しました。');
    expect(message.role).toBe('assistant');
  });
});

describe('D — no card when there is nothing to show', () => {
  it('draws none for an empty list', () => {
    // The device failure looked like this on the wire: prose, no candidates.
    const message = assistantMessage('reply-1', {
      reply: 'じゃが芋と玉ねぎが足りません。',
      shoppingSuggestions: [],
    });

    expect(message.suggestions).toBeUndefined();
    expect(hasSuggestionCard(message)).toBe(false);
  });

  it('draws none when the field is missing', () => {
    const message = assistantMessage('reply-1', { reply: 'こんにちは。' });

    expect(hasSuggestionCard(message)).toBe(false);
  });

  it('draws none when the field is null', () => {
    const message = assistantMessage('reply-1', {
      reply: 'こんにちは。',
      shoppingSuggestions: null,
    });

    expect(hasSuggestionCard(message)).toBe(false);
  });

  it('never attaches an empty array, which would be a truthy no-op', () => {
    const message = assistantMessage('reply-1', { reply: 'x', shoppingSuggestions: [] });

    // `message.suggestions ? <Card/> : null` would draw an empty card if this
    // were `[]` rather than absent.
    expect('suggestions' in message).toBe(false);
  });
});
