import { describe, expect, it } from 'vitest';

import {
  canRetry,
  describeFailure,
  INITIAL_TURN,
  markOverdue,
  overdue,
  reduceTurn,
  TURN_TIMEOUTS,
  type TurnState,
  type VoiceEvent,
} from './turn-state';

/**
 * The order a liveness check has to follow when it interrupts a reply.
 *
 * The trace showed `response.cancel` and `response.create` leaving in the same
 * millisecond. A cancel is asynchronous — the response is not gone until its
 * `response.done` arrives — so the create asked for a second response while
 * the first was still active, which the server refuses. That is the shape of
 * the 60-second silence, though the silence itself was never captured.
 *
 * It also pins the correlation rule. An interruption puts several responses in
 * flight, and matching on the event name alone let any of them rewrite the
 * turn: a stale `completed` cleared `waitingSince` and disarmed the watchdog
 * for good, a stale `cancelled` marked a healthy turn unresolved.
 */

function run(events: VoiceEvent[], from: TurnState = INITIAL_TURN): TurnState {
  return events.reduce(reduceTurn, from);
}

const T = 2_000_000;

/** A reply is being spoken when the user cuts in. */
const speaking = run([
  { type: 'speech_started', at: T },
  { type: 'speech_stopped', at: T + 400 },
  { type: 'committed', at: T + 500 },
  { type: 'response_created', at: T + 800, responseId: 'R3' },
]);

describe('I — cancel, then its done, then the reply', () => {
  it('waits for the cancel instead of creating alongside it', () => {
    const cancelling = reduceTurn(speaking, {
      type: 'liveness_cancel_sent',
      at: T + 1000,
      responseId: 'R3',
    });

    expect(cancelling.phase).toBe('cancelling_response');
    expect(cancelling.cancellingResponseId).toBe('R3');
    // Not yet allowed to create — that is the whole point.
    expect(cancelling.phase).not.toBe('awaiting_liveness_create');
  });

  it('unblocks the reply only when the cancelled response reports', () => {
    const state = run(
      [
        { type: 'liveness_cancel_sent', at: T + 1000, responseId: 'R3' },
        { type: 'response_done', at: T + 1400, responseId: 'R3', status: 'cancelled' },
      ],
      speaking,
    );

    expect(state.phase).toBe('awaiting_liveness_create');
    expect(state.cancellingResponseId).toBeNull();
    expect(state.activeResponseId).toBeNull();
  });

  it('does not unblock on some other response finishing first', () => {
    // R9 is unrelated. If it were treated as the cancellation, the reply would
    // be created while R3 is still generating — the original bug.
    const state = run(
      [
        { type: 'liveness_cancel_sent', at: T + 1000, responseId: 'R3' },
        { type: 'response_done', at: T + 1200, responseId: 'R9', status: 'completed' },
      ],
      speaking,
    );

    expect(state.phase).toBe('cancelling_response');
    expect(state.cancellingResponseId).toBe('R3');
  });

  it('runs the whole sequence through to a completed neutral reply', () => {
    const state = run(
      [
        { type: 'liveness_cancel_sent', at: T + 1000, responseId: 'R3' },
        { type: 'response_done', at: T + 1400, responseId: 'R3', status: 'cancelled' },
        { type: 'liveness_create_sent', at: T + 1450 },
        { type: 'response_created', at: T + 1600, responseId: 'R5' },
        { type: 'response_done', at: T + 3000, responseId: 'R5', status: 'completed' },
      ],
      speaking,
    );

    expect(state.phase).toBe('completed');
    expect(state.failure).toBeNull();
  });

  it('keeps the liveness reply distinguishable while it generates', () => {
    const state = run(
      [
        { type: 'liveness_cancel_sent', at: T + 1000, responseId: 'R3' },
        { type: 'response_done', at: T + 1400, responseId: 'R3', status: 'cancelled' },
        { type: 'liveness_create_sent', at: T + 1450 },
        { type: 'response_created', at: T + 1600, responseId: 'R5' },
      ],
      speaking,
    );

    expect(state.phase).toBe('awaiting_liveness_response');
  });
});

describe('J — a response that is not ours changes nothing', () => {
  it('ignores a stale completed rather than ending the turn', () => {
    // This is what disarmed the watchdog: `completed` set waitingSince to null
    // and moved the phase to completed, permanently.
    const state = reduceTurn(speaking, {
      type: 'response_done',
      at: T + 1200,
      responseId: 'R1',
      status: 'completed',
    });

    expect(state).toBe(speaking);
    expect(state.phase).toBe('responding');
    expect(state.waitingSince).not.toBeNull();
  });

  it('ignores a stale cancelled rather than declaring the turn unresolved', () => {
    const state = reduceTurn(speaking, {
      type: 'response_done',
      at: T + 1200,
      responseId: 'R1',
      status: 'cancelled',
    });

    expect(state.phase).toBe('responding');
    expect(state.failure).toBeNull();
  });

  it('still acts on the response the turn is actually waiting for', () => {
    const state = reduceTurn(speaking, {
      type: 'response_done',
      at: T + 2000,
      responseId: 'R3',
      status: 'completed',
    });

    expect(state.phase).toBe('completed');
  });

  it('keeps the interrupted response id instead of discarding it', () => {
    // Needed to recognise its `done` later as belonging to the old response.
    const interrupted = reduceTurn(speaking, { type: 'speech_started', at: T + 1000 });

    expect(interrupted.interruptedResponseId).toBe('R3');
  });

  it('leaves the watchdog armed across a stale done', () => {
    const state = reduceTurn(speaking, {
      type: 'response_done',
      at: T + 1200,
      responseId: 'R1',
      status: 'completed',
    });

    expect(overdue(state, T + 800 + TURN_TIMEOUTS.noContinuationMs)).toBe('no_continuation');
  });
});

describe('K — the liveness reply never arrives', () => {
  it('watches the wait for the cancel to report', () => {
    const cancelling = reduceTurn(speaking, {
      type: 'liveness_cancel_sent',
      at: T + 1000,
      responseId: 'R3',
    });

    expect(overdue(cancelling, T + 1000 + 1000)).toBeNull();
    expect(overdue(cancelling, T + 1000 + TURN_TIMEOUTS.noContinuationMs)).toBe('no_continuation');
  });

  it('watches the gap between the cancel reporting and the reply being sent', () => {
    const awaiting = run(
      [
        { type: 'liveness_cancel_sent', at: T + 1000, responseId: 'R3' },
        { type: 'response_done', at: T + 1400, responseId: 'R3', status: 'cancelled' },
      ],
      speaking,
    );

    expect(overdue(awaiting, T + 1400 + TURN_TIMEOUTS.noContinuationMs)).toBe('no_continuation');
  });

  it('watches the reply itself', () => {
    const awaiting = run(
      [
        { type: 'liveness_cancel_sent', at: T + 1000, responseId: 'R3' },
        { type: 'response_done', at: T + 1400, responseId: 'R3', status: 'cancelled' },
        { type: 'liveness_create_sent', at: T + 1450 },
      ],
      speaking,
    );

    expect(overdue(awaiting, T + 1450 + TURN_TIMEOUTS.noContinuationMs)).toBe('no_continuation');
  });

  it('shows a recovery message and offers a retry when it times out', () => {
    // The realistic shape: the create went out, nothing ever came back, and
    // the watchdog is what ends the wait.
    const awaiting = run(
      [
        { type: 'liveness_cancel_sent', at: T + 1000, responseId: 'R3' },
        { type: 'response_done', at: T + 1400, responseId: 'R3', status: 'cancelled' },
        { type: 'liveness_create_sent', at: T + 1450 },
      ],
      speaking,
    );

    const failure = overdue(awaiting, T + 1450 + TURN_TIMEOUTS.noContinuationMs);
    expect(failure).toBe('no_continuation');

    const stalled = markOverdue(awaiting, failure!, T + 22000);
    expect(describeFailure(stalled)).not.toBeNull();
    expect(canRetry(stalled)).toBe(true);
  });

  it('reports a liveness reply that comes back failed', () => {
    const stalled = run(
      [
        { type: 'liveness_cancel_sent', at: T + 1000, responseId: 'R3' },
        { type: 'response_done', at: T + 1400, responseId: 'R3', status: 'cancelled' },
        { type: 'liveness_create_sent', at: T + 1450 },
        { type: 'response_created', at: T + 1600, responseId: 'R5' },
        { type: 'response_done', at: T + 2000, responseId: 'R5', status: 'failed' },
      ],
      speaking,
    );

    expect(stalled.phase).toBe('unresolved');
    expect(describeFailure(stalled)).not.toBeNull();
  });

  it('does not watch an ordinary silent listening state', () => {
    // A continuous call may sit quiet for as long as the cook likes.
    const listening = reduceTurn(INITIAL_TURN, { type: 'speech_started', at: T });

    expect(overdue(listening, T + 600_000)).toBeNull();
  });
});
