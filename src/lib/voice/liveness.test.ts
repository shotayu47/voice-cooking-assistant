import { describe, expect, it } from 'vitest';

import {
  classifyUtterance,
  decideLivenessAction,
  livenessInstructions,
  NEUTRAL_ACK,
} from './liveness';

/**
 * 「もしもし？」 must not be answered with the next cooking step.
 *
 * On the device, a turn went unanswered, the user asked whether anyone was
 * there, and the assistant replied with a step from the cooking session in
 * progress — a dish that had nothing to do with the shopping question still
 * waiting for an answer.
 */

describe('10 — a liveness check during an unfinished turn', () => {
  it('reports the turn instead of starting a new topic', () => {
    const action = decideLivenessAction(classifyUtterance('もしもし？'), true);

    expect(action).toBe('report_unresolved');
  });

  it('forbids cooking guidance in the instructions it sends', () => {
    const instructions = livenessInstructions('report_unresolved', '応答を受け取れませんでした。');

    expect(instructions).toContain('調理の工程や次の手順を案内してはいけません');
    expect(instructions).toContain('新しい話題を始めてはいけません');
  });

  it('tells the model what actually happened to the turn', () => {
    const instructions = livenessInstructions('report_unresolved', '応答を受け取れませんでした。');

    expect(instructions).toContain('直前の応答が完了しませんでした');
  });

  for (const phrase of ['もしもし', '聞こえてる？', '聞こえますか', 'おーい', 'あれ？']) {
    it(`recognises ${phrase} as a liveness check`, () => {
      expect(classifyUtterance(phrase)).toBe('liveness_check');
    });
  }
});

describe('11 — a liveness check with nothing outstanding', () => {
  it('answers neutrally rather than picking a topic', () => {
    expect(decideLivenessAction(classifyUtterance('もしもし？'), false)).toBe('neutral_ack');
  });

  it('asks which thread to continue instead of choosing one', () => {
    expect(NEUTRAL_ACK).toBe('聞こえています。どの話を続けますか？');
    expect(livenessInstructions('neutral_ack', null)).toContain(NEUTRAL_ACK);
  });

  it('still forbids volunteering the cooking step', () => {
    expect(livenessInstructions('neutral_ack', null)).toContain(
      '調理の工程や次の手順を案内してはいけません',
    );
  });
});

describe('12 — asking for cooking guidance still works', () => {
  for (const phrase of ['次の工程を教えて', '調理を続けて', '次のステップは？', '手順を教えて']) {
    it(`treats ${phrase} as an explicit cooking request`, () => {
      expect(classifyUtterance(phrase)).toBe('explicit_cooking');
    });
  }

  it('passes an explicit cooking request through untouched', () => {
    // Even with a turn outstanding: the user asked for this one.
    expect(decideLivenessAction(classifyUtterance('次の工程を教えて'), true)).toBe('pass_through');
  });
});

describe('what must not be mistaken for a liveness check', () => {
  it('leaves お願いします alone', () => {
    // An ordinary way to ask for something. Treating it as a liveness check
    // would swallow real requests.
    expect(classifyUtterance('お願いします')).toBe('request');
    expect(classifyUtterance('これでお願いします')).toBe('request');
  });

  it('leaves a real request that happens to contain a listening word', () => {
    expect(classifyUtterance('聞こえるように大きめに切ってください')).toBe('request');
  });

  it('treats an ordinary shopping request as a request', () => {
    expect(classifyUtterance('肉じゃがの買い物候補を出して')).toBe('request');
  });

  it('passes ordinary requests through regardless of turn state', () => {
    expect(decideLivenessAction(classifyUtterance('お願いします'), true)).toBe('pass_through');
    expect(decideLivenessAction(classifyUtterance('お願いします'), false)).toBe('pass_through');
  });

  it('treats an empty transcript as a request, not a check', () => {
    expect(classifyUtterance('   ')).toBe('request');
  });
});
