import { describe, expect, it } from 'vitest';

import {
  canExecuteCall,
  canRequestContinuation,
  canRetry,
  canSendToolOutput,
  describeFailure,
  INITIAL_TURN,
  isUnresolved,
  markOverdue,
  overdue,
  reduceTurn,
  TURN_TIMEOUTS,
  type TurnState,
  type VoiceEvent,
} from './turn-state';

/**
 * The voice turn lifecycle, including every way it was observed to die.
 *
 * On the device: turns cut off mid-sentence, utterances accepted but never
 * answered, and — after the silence — a "もしもし？" answered with the next
 * cooking step of an unrelated dish. None of those states existed in the code,
 * so none of them could be detected, reported, or recovered from.
 */

function run(events: VoiceEvent[], from: TurnState = INITIAL_TURN): TurnState {
  return events.reduce(reduceTurn, from);
}

const T = 1_000_000;

/** A user turn that has been committed and is awaiting an answer. */
const committed: VoiceEvent[] = [
  { type: 'speech_started', at: T },
  { type: 'speech_stopped', at: T + 1000 },
  { type: 'committed', at: T + 1100 },
];

describe('1 — an ordinary turn completes', () => {
  it('ends in completed after a finished response', () => {
    const state = run([
      ...committed,
      { type: 'response_created', at: T + 1500, responseId: 'resp_1' },
      { type: 'response_done', at: T + 4000, responseId: 'resp_1', status: 'completed' },
    ]);

    expect(state.phase).toBe('completed');
    expect(state.failure).toBeNull();
    expect(isUnresolved(state)).toBe(false);
  });

  it('creates exactly one first response for the turn', () => {
    const state = run([
      ...committed,
      { type: 'response_created', at: T + 1500, responseId: 'resp_1' },
      { type: 'response_done', at: T + 4000, responseId: 'resp_1', status: 'completed' },
    ]);

    expect(state.responsesCreated).toBe(1);
  });

  it('clears the active response so the next one is not blocked', () => {
    const state = run([
      ...committed,
      { type: 'response_created', at: T + 1500, responseId: 'resp_1' },
      { type: 'response_done', at: T + 4000, responseId: 'resp_1', status: 'completed' },
    ]);

    expect(state.activeResponseId).toBeNull();
  });
});

describe('2 — a tool turn continues after the output', () => {
  const toolTurn: VoiceEvent[] = [
    ...committed,
    { type: 'response_created', at: T + 1500, responseId: 'resp_1' },
    { type: 'function_call_ready', at: T + 2500, callId: 'call_a' },
    { type: 'response_done', at: T + 2600, responseId: 'resp_1', status: 'completed' },
    { type: 'card_shown', at: T + 3000 },
    { type: 'tool_output_sent', at: T + 3100, callId: 'call_a' },
    { type: 'continuation_requested', at: T + 3200 },
    { type: 'response_created', at: T + 3400, responseId: 'resp_2' },
    { type: 'response_done', at: T + 6000, responseId: 'resp_2', status: 'completed' },
  ];

  it('ends completed once the continuation finishes', () => {
    expect(run(toolTurn).phase).toBe('completed');
  });

  it('asks for exactly one continuation', () => {
    expect(run(toolTurn).continuationsRequested).toBe(1);
  });

  it('does not treat the tool-carrying response as the end of the turn', () => {
    // The turn is not over when the model asks for a tool; it is over when the
    // reply that uses the tool's answer arrives.
    const upToTool = run(toolTurn.slice(0, 4));

    expect(upToTool.phase).not.toBe('completed');
  });
});

describe('3 — one tool event, however many times it arrives', () => {
  it('refuses to execute the same call twice', () => {
    const state = run([
      ...committed,
      { type: 'response_created', at: T + 1500, responseId: 'resp_1' },
      { type: 'function_call_ready', at: T + 2500, callId: 'call_a' },
    ]);

    expect(canExecuteCall(state, 'call_a')).toBe(false);
    expect(canExecuteCall(state, 'call_b')).toBe(true);
  });

  it('records a repeated call once', () => {
    const state = run([
      ...committed,
      { type: 'function_call_ready', at: T + 2500, callId: 'call_a' },
      { type: 'function_call_ready', at: T + 2600, callId: 'call_a' },
    ]);

    expect(state.callsSeen).toEqual(['call_a']);
  });

  it('sends the output for one call at most once', () => {
    const state = run([
      ...committed,
      { type: 'tool_output_sent', at: T + 3000, callId: 'call_a' },
    ]);

    expect(canSendToolOutput(state, 'call_a')).toBe(false);
    expect(state.outputsSent).toEqual(['call_a']);
  });

  it('asks for one continuation at most, per turn', () => {
    const state = run([
      ...committed,
      { type: 'tool_output_sent', at: T + 3000, callId: 'call_a' },
      { type: 'continuation_requested', at: T + 3100 },
    ]);

    expect(canRequestContinuation(state)).toBe(false);
  });

  it('never asks for a continuation while a response is still active', () => {
    // create_response: true means the server may already be answering. A
    // second concurrent request is refused, and the turn gets no reply at all.
    const state = run([
      ...committed,
      { type: 'response_created', at: T + 1500, responseId: 'resp_1' },
      { type: 'tool_output_sent', at: T + 3000, callId: 'call_a' },
    ]);

    expect(state.activeResponseId).toBe('resp_1');
    expect(canRequestContinuation(state)).toBe(false);
  });
});

describe('4-6 — a response that did not complete is not a completed one', () => {
  for (const status of ['failed', 'cancelled', 'incomplete'] as const) {
    it(`treats ${status} as unresolved, not done`, () => {
      const state = run([
        ...committed,
        { type: 'response_created', at: T + 1500, responseId: 'resp_1' },
        { type: 'response_done', at: T + 4000, responseId: 'resp_1', status },
      ]);

      expect(state.phase).toBe('unresolved');
      expect(state.failure).toBe(status);
      expect(isUnresolved(state)).toBe(true);
    });
  }

  it('says something specific about a cancelled turn', () => {
    const state = run([
      ...committed,
      { type: 'response_created', at: T + 1500, responseId: 'resp_1' },
      { type: 'response_done', at: T + 4000, responseId: 'resp_1', status: 'cancelled' },
    ]);

    expect(describeFailure(state)).toContain('中断');
  });

  it('offers a retry, because the user item is already committed', () => {
    const state = run([
      ...committed,
      { type: 'response_done', at: T + 4000, responseId: 'resp_1', status: 'failed' },
    ]);

    expect(canRetry(state)).toBe(true);
  });
});

describe('7-8 — waits that never end', () => {
  it('gives up when a committed turn produces no response', () => {
    const state = run(committed);

    expect(overdue(state, T + 1100 + TURN_TIMEOUTS.noResponseMs)).toBe('no_response');
  });

  it('keeps waiting while the model is still within the observed range', () => {
    // Tool round trips inside one turn measured 1-10s in the QA ledger.
    const state = run(committed);

    expect(overdue(state, T + 1100 + 10_000)).toBeNull();
  });

  it('gives up when the reply after a tool never finishes', () => {
    const state = run([
      ...committed,
      { type: 'response_created', at: T + 1500, responseId: 'resp_1' },
      { type: 'function_call_ready', at: T + 2500, callId: 'call_a' },
      { type: 'response_done', at: T + 2600, responseId: 'resp_1', status: 'completed' },
      { type: 'tool_output_sent', at: T + 3000, callId: 'call_a' },
      { type: 'continuation_requested', at: T + 3100 },
    ]);

    expect(overdue(state, T + 3100 + TURN_TIMEOUTS.noContinuationMs)).toBe('no_continuation');
  });

  it('stops waiting once the turn is finished', () => {
    const state = run([
      ...committed,
      { type: 'response_created', at: T + 1500, responseId: 'resp_1' },
      { type: 'response_done', at: T + 4000, responseId: 'resp_1', status: 'completed' },
    ]);

    expect(overdue(state, T + 999_999)).toBeNull();
  });

  it('reports a timed-out turn rather than staying silent', () => {
    const state = markOverdue(run(committed), 'no_response', T + 20_000);

    expect(state.phase).toBe('unresolved');
    expect(describeFailure(state)).toBe('応答を受け取れませんでした。');
  });

  it('treats a lost channel as unresolved and not retryable', () => {
    const state = run([...committed, { type: 'channel_lost', at: T + 3000 }]);

    expect(state.phase).toBe('unresolved');
    expect(canRetry(state)).toBe(false);
  });
});

describe('9 — the card outlives the voice failure', () => {
  it('keeps cardShown when the continuation then fails', () => {
    const state = run([
      ...committed,
      { type: 'response_created', at: T + 1500, responseId: 'resp_1' },
      { type: 'function_call_ready', at: T + 2500, callId: 'call_a' },
      { type: 'response_done', at: T + 2600, responseId: 'resp_1', status: 'completed' },
      { type: 'card_shown', at: T + 3000 },
      { type: 'tool_output_sent', at: T + 3100, callId: 'call_a' },
      { type: 'continuation_requested', at: T + 3200 },
      { type: 'response_done', at: T + 6000, responseId: 'resp_2', status: 'failed' },
    ]);

    expect(state.cardShown).toBe(true);
    expect(state.phase).toBe('unresolved');
  });

  it('says the candidates survived, so the message does not read as total loss', () => {
    const state = run([
      ...committed,
      { type: 'card_shown', at: T + 3000 },
      { type: 'response_done', at: T + 6000, responseId: 'resp_2', status: 'failed' },
    ]);

    expect(describeFailure(state)).toContain('候補は表示できました');
  });
});

describe('recovery', () => {
  it('clears the failure when the user asks again', () => {
    const stalled = markOverdue(run(committed), 'no_response', T + 20_000);
    const retried = reduceTurn(stalled, { type: 'retry_requested', at: T + 25_000 });

    expect(retried.phase).toBe('waiting_for_response');
    expect(retried.failure).toBeNull();
  });

  it('does not count an API error as a dead turn on its own', () => {
    // The response may still arrive; only the timeout decides.
    const state = run([...committed, { type: 'api_error', at: T + 2000 }]);

    expect(isUnresolved(state)).toBe(false);
    expect(state.phase).toBe('recoverable_error');
  });

  it('goes back to listening when the user speaks again', () => {
    const stalled = markOverdue(run(committed), 'no_response', T + 20_000);
    const fresh = reduceTurn(stalled, { type: 'speech_started', at: T + 30_000 });

    expect(fresh.phase).toBe('listening');
    expect(fresh.failure).toBeNull();
  });

  it('starts a clean turn once the new speech is committed', () => {
    // The budget is tied to a committed turn, not to speech — see
    // `forced-final.test.ts` for why speech alone must not refresh it.
    const stalled = markOverdue(run(committed), 'no_response', T + 20_000);
    const fresh = run(
      [
        { type: 'speech_started', at: T + 30_000 },
        { type: 'speech_stopped', at: T + 31_000 },
        { type: 'committed', at: T + 31_100 },
      ],
      stalled,
    );

    expect(fresh.phase).toBe('waiting_for_response');
    expect(fresh.failure).toBeNull();
    expect(fresh.callsSeen).toEqual([]);
    expect(fresh.continuationsRequested).toBe(0);
  });
});
