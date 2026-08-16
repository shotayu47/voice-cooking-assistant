import { describe, expect, it } from 'vitest';

import { classifyErrorMessage, ERROR_PATTERNS } from './error-classify';

/**
 * `error.message` is free text and can quote the conversation, so it must
 * never reach the trace. These pin that the classifier is a one-way door: a
 * token comes out, and nothing of the input survives.
 */

describe('classifying a Realtime error', () => {
  it('recognises the conflict this investigation is about', () => {
    expect(
      classifyErrorMessage('Conversation already has an active response'),
    ).toBe('active_response_conflict');
  });

  it('recognises a cancel with nothing to cancel', () => {
    expect(classifyErrorMessage('Cancellation failed: no active response found')).toBe(
      'no_active_response',
    );
  });

  it('recognises the common transport failures', () => {
    expect(classifyErrorMessage('Rate limit reached for realtime')).toBe('rate_limit');
    expect(classifyErrorMessage('The request timed out.')).toBe('timeout');
    expect(classifyErrorMessage('Your session has expired')).toBe('session_expired');
  });

  it('says unclassified rather than guessing', () => {
    // A missing pattern is a fact worth knowing; a wrong one is not.
    expect(classifyErrorMessage('Something entirely new happened')).toBe('unclassified');
  });

  it('returns nothing when there is no message', () => {
    expect(classifyErrorMessage(undefined)).toBeUndefined();
    expect(classifyErrorMessage('')).toBeUndefined();
    expect(classifyErrorMessage('   ')).toBeUndefined();
    expect(classifyErrorMessage({ message: 'x' })).toBeUndefined();
  });
});

describe('nothing of the message survives', () => {
  it('never returns any substring of the input', () => {
    const message =
      'Invalid value for item: 肉じゃがのレシピ (user someone@example.com, key sk-live-abc)';
    const token = classifyErrorMessage(message);

    expect(token).toBeDefined();
    for (const secret of ['肉じゃが', 'someone@example.com', 'sk-live', 'Invalid value']) {
      expect(token).not.toContain(secret);
    }
  });

  it('only ever returns a token from the closed set', () => {
    const allowed = new Set<string>([...ERROR_PATTERNS.map((p) => p.token), 'unclassified']);
    const messages = [
      'Conversation already has an active response',
      'no active response',
      'rate limit',
      'timed out',
      'こんにちは、玉ねぎを切ってください',
      '{"tool":"suggest_shopping_items","args":{"recipe_ids":["abc"]}}',
      'x'.repeat(5000),
    ];

    for (const message of messages) {
      const token = classifyErrorMessage(message);
      expect(token && allowed.has(token)).toBe(true);
    }
  });

  it('does not leak content through a message that looks like a tool payload', () => {
    const token = classifyErrorMessage('invalid: {"name":"じゃがいも","quantity":2}');

    expect(token).toBe('invalid_request');
    expect(token).not.toContain('じゃがいも');
  });
});
