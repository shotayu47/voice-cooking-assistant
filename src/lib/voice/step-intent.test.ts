import { describe, expect, it } from 'vitest';

import {
  classifyPreviousUtterance,
  classifyStepUtterance,
  decideAdvance,
  decidePrevious,
  refusedAdvanceOutput,
  refusedPreviousOutput,
} from './step-intent';

/**
 * "次の工程を教えて" moved the cooking session forward twice and marked two
 * steps complete that nobody had done. The user asked to *hear* the next step.
 *
 * The gate is fail-closed on purpose: `advance_cooking_step` writes to the
 * database, so it runs only when the utterance can be positively read as
 * authorising it. A prompt already told the model not to do this and was
 * overridden anyway, which is why the check lives here instead.
 */

describe('1-3 — asking about the step never moves it', () => {
  for (const utterance of [
    '次の工程を教えて',
    '次なに？',
    '今どこ？',
    '現在の工程は？',
    'この次は何をする？',
    '次の手順を教えてください',
  ]) {
    it(`treats "${utterance}" as read-only`, () => {
      expect(classifyStepUtterance(utterance)).toBe('read_only');
    });

    it(`refuses to advance for "${utterance}"`, () => {
      expect(decideAdvance(utterance, 0)).toBe('refuse_unauthorised');
    });
  }

  for (const utterance of ['何分くらい？', '火力はどのくらい？', '分量はどれくらい？']) {
    it(`treats the question "${utterance}" as read-only`, () => {
      expect(decideAdvance(utterance, 0)).toBe('refuse_unauthorised');
    });
  }
});

describe('4 — an explicit completion advances once', () => {
  for (const utterance of [
    'できた',
    '終わった',
    'この工程は完了',
    '次へ進めて',
    'この工程を完了にして',
    'できました',
  ]) {
    it(`allows "${utterance}"`, () => {
      expect(classifyStepUtterance(utterance)).toBe('advance');
      expect(decideAdvance(utterance, 0)).toBe('allow');
    });
  }

  it('needs no confirmation question, so hands stay free', () => {
    // The decision is 'allow' outright — nothing here asks the user again.
    expect(decideAdvance('できた', 0)).toBe('allow');
  });
});

describe('5 — one advance per turn, however many calls arrive', () => {
  it('refuses the second even with the same authorising utterance', () => {
    expect(decideAdvance('できた', 1)).toBe('refuse_already_advanced');
    expect(decideAdvance('できた', 2)).toBe('refuse_already_advanced');
  });
});

describe('6 — default deny', () => {
  it('refuses a bare 次, which is what caused this', () => {
    expect(classifyStepUtterance('次')).toBe('ambiguous');
    expect(decideAdvance('次', 0)).toBe('refuse_unauthorised');
  });

  it('refuses when no transcript could be correlated', () => {
    // An interruption or a retry can leave a tool call with no utterance it
    // can be attributed to. That is a refusal, not a guess.
    expect(decideAdvance(null, 0)).toBe('refuse_unauthorised');
    expect(decideAdvance(undefined, 0)).toBe('refuse_unauthorised');
    expect(decideAdvance('', 0)).toBe('refuse_unauthorised');
    expect(decideAdvance('   ', 0)).toBe('refuse_unauthorised');
  });

  it('refuses an utterance that both asks and declares', () => {
    // "完了したか教えて" asks about completion; it does not perform one.
    expect(classifyStepUtterance('完了したか教えて')).toBe('ambiguous');
    expect(decideAdvance('完了したか教えて', 0)).toBe('refuse_unauthorised');
  });

  it('refuses a non-string transcript', () => {
    expect(classifyStepUtterance(42 as unknown as string)).toBe('ambiguous');
  });
});

describe('going back is a write too', () => {
  it('refuses "前の工程を教えて" — the question, not the undo', () => {
    expect(classifyPreviousUtterance('前の工程を教えて')).toBe('read_only');
    expect(decidePrevious('前の工程を教えて', 0)).toBe('refuse_unauthorised');
  });

  for (const utterance of [
    'ひとつ前は何？',
    'さっきの手順を教えて',
    'さっきの工程をもう一度教えて',
    '前の工程は？',
  ]) {
    it(`refuses "${utterance}"`, () => {
      expect(decidePrevious(utterance, 0)).toBe('refuse_unauthorised');
    });
  }

  for (const utterance of [
    '前の工程へ戻して',
    'ひとつ前に戻して',
    '工程を戻してください',
    'さっきの工程を未完了に戻して',
  ]) {
    it(`allows "${utterance}"`, () => {
      expect(classifyPreviousUtterance(utterance)).toBe('advance');
      expect(decidePrevious(utterance, 0)).toBe('allow');
    });
  }

  it('refuses a bare 前', () => {
    expect(classifyPreviousUtterance('前')).toBe('ambiguous');
    expect(decidePrevious('前', 0)).toBe('refuse_unauthorised');
  });

  it('refuses with no transcript, or one from another turn', () => {
    expect(decidePrevious(null, 0)).toBe('refuse_unauthorised');
    expect(decidePrevious(undefined, 0)).toBe('refuse_unauthorised');
    expect(decidePrevious('', 0)).toBe('refuse_unauthorised');
  });

  it('refuses an utterance that both asks and directs', () => {
    expect(decidePrevious('前に戻すか教えて', 0)).toBe('refuse_unauthorised');
  });

  it('moves at most once per turn, sharing the budget with advancing', () => {
    // One committed utterance moves the cooking once, in one direction.
    expect(decidePrevious('前の工程へ戻して', 1)).toBe('refuse_already_advanced');
    expect(decideAdvance('できた', 1)).toBe('refuse_already_advanced');
  });

  it('does not let 未完了 read as a completion', () => {
    // 「未完了に戻して」 contains 完了 and means the opposite.
    expect(classifyStepUtterance('さっきの工程を未完了に戻して')).not.toBe('advance');
  });

  it('answers the model without touching the database', () => {
    const output = refusedPreviousOutput('refuse_unauthorised', {
      current_step: 3,
      total_steps: 7,
    }) as Record<string, unknown>;

    expect(output.moved).toBe(false);
    expect(String(output.message)).toContain('戻していません');
    expect(String(output.message)).toContain('一つ前');
    expect(output.current).toEqual({ current_step: 3, total_steps: 7 });
  });
});

describe('what the model is told when refused', () => {
  it('still returns an output, so the model is not left waiting', () => {
    const output = refusedAdvanceOutput('refuse_unauthorised', null) as Record<string, unknown>;

    expect(output.advanced).toBe(false);
    expect(output.reason).toBe('refuse_unauthorised');
    expect(String(output.message).length).toBeGreaterThan(0);
  });

  it('tells it to read the step out instead', () => {
    const output = refusedAdvanceOutput('refuse_unauthorised', null) as Record<string, unknown>;

    expect(String(output.message)).toContain('現在の工程');
    expect(String(output.message)).toContain('進めていません');
  });

  it('carries the current step when it could be read', () => {
    const output = refusedAdvanceOutput('refuse_unauthorised', {
      current_step: 0,
      total_steps: 7,
    }) as Record<string, unknown>;

    expect(output.current).toEqual({ current_step: 0, total_steps: 7 });
  });

  it('omits the step rather than inventing one', () => {
    const output = refusedAdvanceOutput('refuse_unauthorised', null) as Record<string, unknown>;

    expect('current' in output).toBe(false);
  });

  it('says something different when the turn already advanced', () => {
    const output = refusedAdvanceOutput('refuse_already_advanced', null) as Record<string, unknown>;

    expect(String(output.message)).toContain('二重');
  });
});
