import { describe, expect, it } from 'vitest';

import { classifyErrorMessage, ERROR_PATTERNS, toolOutcomeCode } from './error-classify';

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

describe('a successful relay is not a successful tool', () => {
  it('names the schema failure that used to read as ok', () => {
    /*
     * The exact case: create_recipe rejected for `ingredients.4.amount`,
     * returned over HTTP 200, and logged as `tool_done status=ok`. Reading the
     * trace, nothing had gone wrong; in the database, no recipe existed.
     */
    expect(toolOutcomeCode({ error: 'invalid_arguments', field: 'ingredients.4.amount' })).toBe(
      'invalid_arguments',
    );
  });

  it('says nothing for a result that succeeded', () => {
    // undefined is what makes the trace read `outcome=ok`.
    expect(toolOutcomeCode({ title: 'x', recipe_id: 'r1', total_steps: 7 })).toBeUndefined();
    expect(toolOutcomeCode({})).toBeUndefined();
    expect(toolOutcomeCode(null)).toBeUndefined();
    expect(toolOutcomeCode('not an object')).toBeUndefined();
  });

  it('recognises the codes the tools actually return', () => {
    for (const code of [
      'invalid_arguments',
      'invalid_candidates',
      'no_recipes',
      'recipe_not_found',
      'recipes_not_found',
      'backend_unavailable',
      'unknown_tool',
      'tool_failed',
      'tool_unreachable',
    ]) {
      expect(toolOutcomeCode({ error: code })).toBe(code);
    }
  });

  it('collapses anything unrecognised rather than passing it through', () => {
    // The field is app-authored today; the trace should not become a way for
    // free text to reach the output if that ever changes.
    expect(toolOutcomeCode({ error: 'かつお節が見つかりません' })).toBe('other');
    expect(toolOutcomeCode({ error: 'user someone@example.com failed' })).toBe('other');
  });

  it('ignores a non-string error field', () => {
    expect(toolOutcomeCode({ error: { message: '肉じゃが' } })).toBeUndefined();
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
