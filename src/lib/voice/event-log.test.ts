import { describe, expect, it } from 'vitest';

import { createEventLog, formatEventLog } from './event-log';

/**
 * The trace runs during real cooking sessions, with real transcripts and real
 * inventory a function call away. Redaction is therefore enforced by the log
 * itself rather than by remembering to be careful at each call site, and these
 * pin that it holds even when the call site is wrong.
 */

function log() {
  let now = 0;
  const instance = createEventLog(() => now);
  return { instance, tick: (ms: number) => (now += ms) };
}

describe('what the trace records', () => {
  it('numbers entries and keeps relative timings', () => {
    const { instance, tick } = log();
    instance.add('in', 'input_audio_buffer.committed');
    tick(1500);
    instance.add('in', 'response.created', { resp: 'resp_abc' });

    expect(instance.entries()).toEqual([
      { n: 1, t: 0, dir: 'in', event: 'input_audio_buffer.committed' },
      { n: 2, t: 1500, dir: 'in', event: 'response.created', resp: 'R1' },
    ]);
  });

  it('records direction so inbound and outbound are distinguishable', () => {
    const { instance } = log();
    instance.add('out', 'response.create', { sent: true });
    instance.add('internal', 'watchdog.arm', { reason: 'committed' });

    expect(instance.entries().map((entry) => entry.dir)).toEqual(['out', 'internal']);
  });

  it('keeps the fields needed to diagnose a stalled turn', () => {
    const { instance } = log();
    instance.add('in', 'response.done', {
      resp: 'resp_1',
      status: 'cancelled',
      active: 'resp_2',
      cancelWaiting: 'unspecified',
      pendingLiveness: true,
    });

    expect(instance.entries()[0]).toEqual({
      n: 1,
      t: 0,
      dir: 'in',
      event: 'response.done',
      resp: 'R1',
      status: 'cancelled',
      active: 'R2',
      cancelWaiting: 'R3',
      pendingLiveness: true,
    });
  });

  it('records whether an outbound payload actually left', () => {
    const { instance } = log();
    instance.add('out', 'response.create', { sent: false, reason: 'channel_not_open' });

    expect(instance.entries()[0]).toMatchObject({ sent: false, reason: 'channel_not_open' });
  });

  it('records the phase either side of a reduction', () => {
    const { instance } = log();
    instance.add('internal', 'turn.reduce', { from: 'responding', to: 'unresolved' });

    expect(instance.entries()[0]).toMatchObject({ from: 'responding', to: 'unresolved' });
  });
});

describe('correlation without exposing ids', () => {
  it('replaces every id with a per-call alias', () => {
    const { instance } = log();
    instance.add('in', 'response.created', { resp: 'resp_QX77ghwDvzWrJyA8' });

    const entry = instance.entries()[0];
    expect(entry.resp).toBe('R1');
    expect(JSON.stringify(entry)).not.toContain('QX77');
  });

  it('gives the same id the same alias, so a turn can be followed', () => {
    const { instance } = log();
    instance.add('in', 'response.created', { resp: 'resp_a' });
    instance.add('in', 'response.done', { resp: 'resp_a' });
    instance.add('in', 'response.created', { resp: 'resp_b' });

    expect(instance.entries().map((entry) => entry.resp)).toEqual(['R1', 'R1', 'R2']);
  });

  it('shares one namespace across resp, active and cancelWaiting', () => {
    // Otherwise "the response we waited for" could not be matched against
    // "the response that finished", which is the whole question.
    const { instance } = log();
    instance.add('in', 'response.done', { resp: 'resp_a', active: 'resp_a' });

    expect(instance.entries()[0]).toMatchObject({ resp: 'R1', active: 'R1' });
  });

  it('keeps call and item ids in their own namespaces', () => {
    const { instance } = log();
    instance.add('internal', 'tool_start', { call: 'call_a', item: 'item_a' });

    expect(instance.entries()[0]).toMatchObject({ call: 'C1', item: 'I1' });
  });
});

describe('what the trace must never record', () => {
  it('drops any field it does not explicitly allow', () => {
    const { instance } = log();
    instance.add('in', 'transcription.completed', {
      transcript: '肉じゃがの買い物候補を出して',
      audio: 'AAAA',
      arguments: '{"recipe_ids":["9a6f18a7"]}',
      result: { suggestions: [{ name: 'じゃがいも' }] },
      inventory: ['牛肉', '玉ねぎ'],
      email: 'someone@example.com',
      userId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      authorization: 'Bearer sk-live-123',
      client_secret: 'ek_abc',
      cookie: 'sb-access-token=xyz',
      payload: { type: 'response.done', response: { output: ['secret'] } },
    });

    expect(instance.entries()).toEqual([
      { n: 1, t: 0, dir: 'in', event: 'transcription.completed' },
    ]);
  });

  it('leaves no trace of forbidden values anywhere in the output', () => {
    const { instance } = log();
    instance.add('in', 'response.done', {
      transcript: 'もしもし、じゃがいもを買いたい',
      apiKey: 'sk-live-abcdef',
      resp: 'resp_1',
    });

    const serialised = JSON.stringify(instance.entries()) + formatEventLog(instance.entries());
    for (const secret of ['もしもし', 'じゃがいも', 'sk-live', 'abcdef']) {
      expect(serialised).not.toContain(secret);
    }
  });

  it('turns a string smuggled into an id field into an alias, not text', () => {
    // Even a wrong call site cannot put content in the output.
    const { instance } = log();
    instance.add('in', 'response.done', { resp: '牛肉と玉ねぎのあっさり煮' });

    expect(instance.entries()[0].resp).toBe('R1');
    expect(JSON.stringify(instance.entries())).not.toContain('牛肉');
  });

  it('bounds an allowed text field so it cannot carry a sentence', () => {
    const { instance } = log();
    instance.add('in', 'error', { code: 'x'.repeat(200) });

    expect(instance.entries()[0].code).toHaveLength(40);
  });

  it('bounds the event name too', () => {
    const { instance } = log();
    instance.add('in', 'y'.repeat(200));

    expect(instance.entries()[0].event).toHaveLength(40);
  });

  it('ignores null and undefined instead of recording them', () => {
    const { instance } = log();
    instance.add('in', 'response.done', { resp: undefined, status: null });

    expect(instance.entries()).toEqual([{ n: 1, t: 0, dir: 'in', event: 'response.done' }]);
  });

  it('refuses a non-string in a text field rather than coercing it', () => {
    const { instance } = log();
    instance.add('in', 'response.done', { status: { secret: 'value' } });

    expect(instance.entries()[0].status).toBeUndefined();
  });
});

describe('a long cooking call', () => {
  it('keeps the trace bounded', () => {
    const { instance } = log();
    for (let i = 0; i < 900; i += 1) instance.add('in', 'response.output_audio.done');

    expect(instance.entries().length).toBeLessThanOrEqual(400);
  });

  it('keeps the most recent events, which are the ones that failed', () => {
    const { instance } = log();
    for (let i = 0; i < 500; i += 1) instance.add('in', 'response.output_audio.done');
    instance.add('internal', 'watchdog.fire', { status: 'no_response' });

    expect(instance.entries().at(-1)).toMatchObject({
      event: 'watchdog.fire',
      status: 'no_response',
    });
  });

  it('resets everything, including aliases', () => {
    const { instance } = log();
    instance.add('in', 'response.created', { resp: 'resp_a' });
    instance.clear();
    instance.add('in', 'response.created', { resp: 'resp_b' });

    expect(instance.entries()).toEqual([
      { n: 1, t: 0, dir: 'in', event: 'response.created', resp: 'R1' },
    ]);
  });
});

describe('the copied text', () => {
  it('says what it is and how many entries it holds', () => {
    const { instance } = log();
    instance.add('in', 'response.created', { resp: 'resp_a' });

    expect(formatEventLog(instance.entries())).toContain('# voice trace (redacted');
    expect(formatEventLog(instance.entries())).toContain('# entries: 1');
  });

  it('renders one line per event with direction', () => {
    const { instance } = log();
    instance.add('in', 'response.done', { resp: 'resp_a', status: 'cancelled' });
    instance.add('out', 'response.create', { sent: true });

    const lines = formatEventLog(instance.entries()).trim().split('\n').slice(-2);
    expect(lines[0]).toContain('<- response.done status=cancelled resp=R1');
    expect(lines[1]).toContain('-> response.create sent=true');
  });
});
