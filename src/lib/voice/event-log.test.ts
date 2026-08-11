import { describe, expect, it } from 'vitest';

import { createEventLog, formatEventLog } from './event-log';

/**
 * The trace exists to diagnose stalled turns, which means it runs during real
 * cooking sessions with real transcripts and real inventory nearby. The
 * redaction is therefore enforced by the log itself, not by remembering to be
 * careful at each call site.
 */

function log() {
  let now = 0;
  const instance = createEventLog(() => now);
  return { instance, tick: (ms: number) => (now += ms) };
}

describe('what the trace records', () => {
  it('keeps the sequence with relative timings', () => {
    const { instance, tick } = log();
    instance.add('committed');
    tick(1500);
    instance.add('response_created', { responseId: 'resp_1' });

    expect(instance.entries()).toEqual([
      { t: 0, event: 'committed' },
      { t: 1500, event: 'response_created', responseId: 'resp_1' },
    ]);
  });

  it('keeps the fields needed to correlate a turn', () => {
    const { instance } = log();
    instance.add('tool_done', { tool: 'suggest_shopping_items', callId: 'call_a', ms: 812 });

    expect(instance.entries()[0]).toEqual({
      t: 0,
      event: 'tool_done',
      tool: 'suggest_shopping_items',
      callId: 'call_a',
      ms: 812,
    });
  });

  it('formats one line per event', () => {
    const { instance } = log();
    instance.add('response_done', { responseId: 'resp_1', status: 'cancelled' });

    expect(formatEventLog(instance.entries())).toBe(
      '     0ms response_done status=cancelled resp=resp_1',
    );
  });
});

describe('what the trace must never record', () => {
  it('drops any field it does not explicitly allow', () => {
    const { instance } = log();
    instance.add('transcription_completed', {
      transcript: '肉じゃがの買い物候補を出して',
      audio: 'AAAA',
      arguments: '{"recipe_ids":["..."]}',
      result: { suggestions: [{ name: 'じゃがいも' }] },
      email: 'someone@example.com',
      authorization: 'Bearer sk-live',
    });

    expect(instance.entries()).toEqual([{ t: 0, event: 'transcription_completed' }]);
  });

  it('does not let a long string ride in on an allowed field', () => {
    const { instance } = log();
    instance.add('error', { status: 'x'.repeat(200) });

    expect(instance.entries()[0].status).toHaveLength(40);
  });

  it('truncates ids rather than storing unbounded strings', () => {
    const { instance } = log();
    instance.add('item_created', { itemId: 'i'.repeat(100) });

    expect(instance.entries()[0].itemId!.length).toBeLessThanOrEqual(25);
  });

  it('ignores null and undefined instead of recording them', () => {
    const { instance } = log();
    instance.add('response_done', { responseId: undefined, status: null });

    expect(instance.entries()).toEqual([{ t: 0, event: 'response_done' }]);
  });
});

describe('a long cooking call', () => {
  it('keeps the trace bounded', () => {
    const { instance } = log();
    for (let i = 0; i < 500; i += 1) instance.add('speech_started');

    expect(instance.entries().length).toBeLessThanOrEqual(300);
  });

  it('keeps the most recent events, which are the ones that failed', () => {
    const { instance } = log();
    for (let i = 0; i < 400; i += 1) instance.add('speech_started');
    instance.add('overdue', { status: 'no_response' });

    expect(instance.entries().at(-1)).toMatchObject({ event: 'overdue', status: 'no_response' });
  });
});
