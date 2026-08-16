import { describe, expect, it } from 'vitest';

import {
  canRetry,
  describeFailure,
  INITIAL_TURN,
  isUnresolved,
  reduceTurn,
  type TurnState,
  type VoiceEvent,
} from './turn-state';

/**
 * Talking over the assistant is not a failure.
 *
 * The third voice QA passed on conversation, and failed on the UI: 39ms after
 * `input_audio_buffer.speech_started`, the interrupted response reported
 * `cancelled` with `detailReason=turn_detected`, and the reducer turned that
 * into `listening > unresolved` — "応答に失敗しました" with a retry button, on
 * top of a turn that then went on to complete perfectly normally.
 *
 * `turn_detected` is the server's VAD saying a new utterance began. That is
 * the barge-in feature doing its job. Every other cancellation, and every
 * failure, still means what it meant.
 */

function run(events: VoiceEvent[], from: TurnState = INITIAL_TURN): TurnState {
  return events.reduce(reduceTurn, from);
}

const T = 3_000_000;

/** The assistant is mid-reply on R2 when the user starts speaking. */
const speaking = run([
  { type: 'speech_started', at: T },
  { type: 'speech_stopped', at: T + 400 },
  { type: 'committed', at: T + 500 },
  { type: 'response_created', at: T + 800, responseId: 'R2' },
]);

describe('a barge-in is not a failure', () => {
  const bargedIn = reduceTurn(speaking, { type: 'speech_started', at: T + 2000 });

  it('keeps the interrupted response id when speech starts', () => {
    expect(bargedIn.interruptedResponseId).toBe('R2');
    expect(bargedIn.phase).toBe('listening');
  });

  it('stays listening when that response reports turn_detected', () => {
    const state = reduceTurn(bargedIn, {
      type: 'response_done',
      at: T + 2039,
      responseId: 'R2',
      status: 'cancelled',
      reason: 'turn_detected',
    });

    expect(state.phase).toBe('listening');
    expect(state.failure).toBeNull();
    expect(isUnresolved(state)).toBe(false);
  });

  it('shows nothing to the user', () => {
    const state = reduceTurn(bargedIn, {
      type: 'response_done',
      at: T + 2039,
      responseId: 'R2',
      status: 'cancelled',
      reason: 'turn_detected',
    });

    expect(describeFailure(state)).toBeNull();
    expect(canRetry(state)).toBe(false);
  });

  it('releases the response so the next one is not blocked', () => {
    const state = reduceTurn(bargedIn, {
      type: 'response_done',
      at: T + 2039,
      responseId: 'R2',
      status: 'cancelled',
      reason: 'turn_detected',
    });

    expect(state.activeResponseId).toBeNull();
    expect(state.interruptedResponseId).toBeNull();
  });

  it('carries straight on into the next turn', () => {
    // Exactly what the device did: the following utterance produced R3 and
    // completed. Nothing about the interruption should leave a mark.
    const state = run(
      [
        { type: 'response_done', at: T + 2039, responseId: 'R2', status: 'cancelled', reason: 'turn_detected' },
        { type: 'speech_stopped', at: T + 2500 },
        { type: 'committed', at: T + 2600 },
        { type: 'response_created', at: T + 3000, responseId: 'R3' },
        { type: 'response_done', at: T + 6000, responseId: 'R3', status: 'completed' },
      ],
      bargedIn,
    );

    expect(state.phase).toBe('completed');
    expect(state.failure).toBeNull();
    expect(describeFailure(state)).toBeNull();
  });
});

describe('a cancelled response never runs its tools', () => {
  it('does not mark the turn completed, which is what gates tool execution', () => {
    /*
     * The hook only executes function calls when `status === 'completed'`.
     * Treating a barge-in as benign must not reach that gate by another route:
     * the response stays cancelled, so its half-built tool calls are still
     * skipped — the defect that started this whole investigation.
     */
    const bargedIn = reduceTurn(speaking, { type: 'speech_started', at: T + 2000 });
    const state = reduceTurn(bargedIn, {
      type: 'response_done',
      at: T + 2039,
      responseId: 'R2',
      status: 'cancelled',
      reason: 'turn_detected',
    });

    expect(state.phase).not.toBe('completed');
    expect(state.callsSeen).toEqual([]);
    expect(state.outputsSent).toEqual([]);
  });
});

describe('what still counts as a failure', () => {
  it('treats a cancellation without turn_detected as unresolved', () => {
    const state = reduceTurn(speaking, {
      type: 'response_done',
      at: T + 2000,
      responseId: 'R2',
      status: 'cancelled',
      reason: 'client_cancelled',
    });

    expect(state.phase).toBe('unresolved');
    expect(state.failure).toBe('cancelled');
  });

  it('treats a cancellation with no reason at all as unresolved', () => {
    const state = reduceTurn(speaking, {
      type: 'response_done',
      at: T + 2000,
      responseId: 'R2',
      status: 'cancelled',
    });

    expect(state.phase).toBe('unresolved');
    expect(state.failure).toBe('cancelled');
  });

  it('still fails on failed and incomplete', () => {
    for (const status of ['failed', 'incomplete'] as const) {
      const state = reduceTurn(speaking, {
        type: 'response_done',
        at: T + 2000,
        responseId: 'R2',
        status,
      });

      expect(state.phase).toBe('unresolved');
      expect(state.failure).toBe(status);
    }
  });

  it('does not excuse a failed response just because it mentions turn_detected', () => {
    // Only `cancelled` is benign; a failure is a failure whatever the reason.
    const state = reduceTurn(speaking, {
      type: 'response_done',
      at: T + 2000,
      responseId: 'R2',
      status: 'failed',
      reason: 'turn_detected',
    });

    expect(state.phase).toBe('unresolved');
  });
});

describe('a barge-in on someone else’s response', () => {
  it('leaves the current turn alone', () => {
    const state = reduceTurn(speaking, {
      type: 'response_done',
      at: T + 2000,
      responseId: 'R9',
      status: 'cancelled',
      reason: 'turn_detected',
    });

    expect(state.phase).toBe('responding');
    expect(state.activeResponseId).toBe('R2');
    expect(state.failure).toBeNull();
  });

  it('leaves an unrelated non-benign cancellation alone too', () => {
    const state = reduceTurn(speaking, {
      type: 'response_done',
      at: T + 2000,
      responseId: 'R9',
      status: 'cancelled',
      reason: 'client_cancelled',
    });

    expect(state).toBe(speaking);
  });
});
