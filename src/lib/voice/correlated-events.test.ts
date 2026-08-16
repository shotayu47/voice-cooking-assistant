import { describe, expect, it } from 'vitest';

import { CORRELATED_EVENTS } from './use-realtime-voice';

/**
 * Adding `event_id` is the only thing this instrumentation changes about what
 * leaves the browser. It has to stay that: confined to the payloads the server
 * can reject, so an `error.event_id` names the send that failed instead of
 * leaving it to be inferred from ordering.
 */

describe('which client events carry an event_id', () => {
  it('is exactly the three the server can reject', () => {
    expect([...CORRELATED_EVENTS].sort()).toEqual([
      'conversation.item.create',
      'response.cancel',
      'response.create',
    ]);
  });

  it('does not tag events that are not rejectable', () => {
    // Nothing correlates these, so tagging them would add noise to the wire
    // for no diagnostic gain.
    expect(CORRELATED_EVENTS.has('session.update')).toBe(false);
    expect(CORRELATED_EVENTS.has('input_audio_buffer.commit')).toBe(false);
    expect(CORRELATED_EVENTS.has('conversation.item.truncate')).toBe(false);
  });
});
