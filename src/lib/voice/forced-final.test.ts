import { describe, expect, it } from 'vitest';

import { argumentSignature, compareSignature } from './arg-signature';
import {
  canForceFinal,
  canRequestContinuation,
  canRetry,
  describeFailure,
  INITIAL_TURN,
  MAX_TOOL_ROUNDS,
  isForcingFinal,
  overdue,
  reduceTurn,
  retryShouldForceFinal,
  TURN_TIMEOUTS,
  type TurnState,
  type VoiceEvent,
} from './turn-state';

/**
 * What happens when the continuation guard trips.
 *
 * The device trace: a tool succeeded, its output was delivered, the guard
 * suppressed the continuation, and the turn sat in `running_tool` until the
 * watchdog declared it stalled 21 seconds later. Pressing "try again" ran the
 * ordinary path, chose a tool once more, and arrived at the same guard — the
 * same 21-second wait, indefinitely.
 *
 * The guard exists to stop an endless tool loop and still does. What it must
 * not stop is the *answer*, which the results already in hand can support.
 */

function run(events: VoiceEvent[], from: TurnState = INITIAL_TURN): TurnState {
  return events.reduce(reduceTurn, from);
}

const T = 1_000_000;

/** A committed user turn awaiting its first response. */
const committed: VoiceEvent[] = [
  { type: 'speech_started', at: T },
  { type: 'speech_stopped', at: T + 500 },
  { type: 'committed', at: T + 600 },
];

/** Through one tool and its continuation — the healthy path. */
const firstTool: VoiceEvent[] = [
  ...committed,
  { type: 'response_created', at: T + 1000, responseId: 'R1' },
  { type: 'function_call_ready', at: T + 1500, callId: 'C1' },
  { type: 'response_done', at: T + 1600, responseId: 'R1', status: 'completed' },
  { type: 'tool_output_sent', at: T + 2000, callId: 'C1' },
  { type: 'continuation_requested', at: T + 2100 },
];

describe('A — a tool, its output, and a spoken answer', () => {
  it('completes when the continuation finishes', () => {
    const state = run([
      ...firstTool,
      { type: 'response_created', at: T + 2300, responseId: 'R2' },
      { type: 'response_done', at: T + 5000, responseId: 'R2', status: 'completed' },
    ]);

    expect(state.phase).toBe('completed');
    expect(state.forcedFinalRequested).toBe(0);
  });

  it('uses the ordinary continuation, not the forced final', () => {
    // The guard has not tripped, so nothing special should happen.
    const state = run(firstTool.slice(0, -1));

    expect(canRequestContinuation(state)).toBe(true);
  });
});

describe('B/C — the guard trips when the budget runs out', () => {
  /**
   * Every round the budget allows, then one more tool whose output has been
   * delivered with nothing left to answer it.
   *
   * The budget used to be one, so this state was reached on the *second* tool
   * — which is why the canonical create_recipe → suggest_shopping_items flow
   * could never finish. It is now the ceiling in `multi-tool-flow.test.ts`;
   * what happens once it is reached is what this file is about.
   */
  const secondTool: VoiceEvent[] = [
    ...firstTool,
    ...Array.from({ length: MAX_TOOL_ROUNDS - 1 }, (_, i) => [
      { type: 'response_created' as const, at: T + 2300 + i * 100, responseId: `Rx${i}` },
      { type: 'tool_output_sent' as const, at: T + 2340 + i * 100, callId: `Cx${i}` },
      { type: 'response_done' as const, at: T + 2360 + i * 100, responseId: `Rx${i}`, status: 'completed' },
      { type: 'continuation_requested' as const, at: T + 2380 + i * 100 },
    ]).flat(),
    { type: 'response_created', at: T + 4300, responseId: 'R2' },
    { type: 'function_call_ready', at: T + 4800, callId: 'C2' },
    { type: 'response_done', at: T + 4900, responseId: 'R2', status: 'completed' },
    { type: 'tool_output_sent', at: T + 5300, callId: 'C2' },
  ];

  it('refuses a further continuation once the budget is spent', () => {
    expect(canRequestContinuation(run(secondTool))).toBe(false);
  });

  it('still allows one forced final', () => {
    // This is the difference: no more tools, but an answer is still owed.
    expect(canForceFinal(run(secondTool))).toBe(true);
  });

  it('leaves running_tool as soon as the forced final is asked for', () => {
    const before = run(secondTool);
    expect(before.phase).toBe('running_tool');

    const after = reduceTurn(before, { type: 'forced_final_requested', at: T + 3400 });
    expect(after.phase).toBe('awaiting_forced_final');
  });

  it('asks for exactly one', () => {
    const state = run([...secondTool, { type: 'forced_final_requested', at: T + 3400 }]);

    expect(state.forcedFinalRequested).toBe(1);
    expect(canForceFinal(state)).toBe(false);
  });

  it('completes the turn when the forced final answers', () => {
    const state = run([
      ...secondTool,
      { type: 'forced_final_requested', at: T + 3400 },
      { type: 'response_created', at: T + 3600, responseId: 'R3' },
      { type: 'response_done', at: T + 6000, responseId: 'R3', status: 'completed' },
    ]);

    expect(state.phase).toBe('completed');
    expect(state.failure).toBeNull();
  });

  it('marks the forced final as distinguishable while it runs', () => {
    const state = run([
      ...secondTool,
      { type: 'forced_final_requested', at: T + 3400 },
      { type: 'response_created', at: T + 3600, responseId: 'R3' },
    ]);

    expect(state.phase).toBe('forced_final_responding');
    expect(isForcingFinal(state)).toBe(true);
  });

  it('does not wait 20s to say something when the final is already spent', () => {
    // Second time the guard trips in one turn: report now, not on a timer.
    const spent = run([...secondTool, { type: 'forced_final_requested', at: T + 3400 }]);
    const state = reduceTurn(spent, { type: 'forced_final_unavailable', at: T + 3500 });

    expect(state.phase).toBe('unresolved');
    expect(state.failure).toBe('forced_final_unavailable');
    expect(describeFailure(state)).toContain('調べた結果はあります');
  });

  it('keeps watching while the forced final is outstanding', () => {
    const state = run([...secondTool, { type: 'forced_final_requested', at: T + 3400 }]);

    expect(overdue(state, T + 3400 + 1000)).toBeNull();
    expect(overdue(state, T + 3400 + TURN_TIMEOUTS.noContinuationMs)).toBe('no_continuation');
  });
});

describe('D — the forced final does not loop', () => {
  const forcing: VoiceEvent[] = [
    ...firstTool,
    { type: 'response_created', at: T + 2300, responseId: 'R2' },
    { type: 'function_call_ready', at: T + 2800, callId: 'C2' },
    { type: 'response_done', at: T + 2900, responseId: 'R2', status: 'completed' },
    { type: 'tool_output_sent', at: T + 3300, callId: 'C2' },
    { type: 'forced_final_requested', at: T + 3400 },
    { type: 'response_created', at: T + 3600, responseId: 'R3' },
  ];

  it('stops instead of asking again when it requests another tool', () => {
    const state = run([...forcing, { type: 'forced_final_looped', at: T + 4000 }]);

    expect(state.phase).toBe('unresolved');
    expect(state.failure).toBe('forced_final_looped');
  });

  it('offers no retry, because retrying is the loop', () => {
    const state = run([...forcing, { type: 'forced_final_looped', at: T + 4000 }]);

    expect(canRetry(state)).toBe(false);
    expect(canForceFinal(state)).toBe(false);
  });

  it('says the results survived even though the sentence did not', () => {
    const state = run([
      ...forcing,
      { type: 'card_shown', at: T + 3700 },
      { type: 'forced_final_looped', at: T + 4000 },
    ]);

    expect(describeFailure(state)).toContain('候補は表示できました');
  });
});

describe('E — retrying a stall does not walk back into the guard', () => {
  const stalled = run([
    ...firstTool,
    { type: 'response_created', at: T + 2300, responseId: 'R2' },
    { type: 'function_call_ready', at: T + 2800, callId: 'C2' },
    { type: 'response_done', at: T + 2900, responseId: 'R2', status: 'completed' },
    { type: 'tool_output_sent', at: T + 3300, callId: 'C2' },
    { type: 'response_done', at: T + 24000, responseId: 'R9', status: 'failed' },
  ]);

  it('routes a retry through the forced final once output was delivered', () => {
    expect(stalled.outputsSent.length).toBeGreaterThan(0);
    expect(retryShouldForceFinal(stalled)).toBe(true);
  });

  it('does not route through it when no tool output is outstanding', () => {
    // A plain "no response at all" turn has nothing to summarise, so the
    // ordinary retry is correct there.
    const plain = run([
      ...committed,
      { type: 'response_done', at: T + 20000, responseId: 'R1', status: 'failed' },
    ]);

    expect(retryShouldForceFinal(plain)).toBe(false);
  });

  it('does not offer the forced-final route twice', () => {
    const afterForced = reduceTurn(stalled, { type: 'forced_final_requested', at: T + 25000 });

    expect(retryShouldForceFinal(afterForced)).toBe(false);
  });
});

describe('F — the budget belongs to a committed user turn', () => {
  const spent = run([
    ...firstTool,
    { type: 'response_created', at: T + 2300, responseId: 'R2' },
    { type: 'function_call_ready', at: T + 2800, callId: 'C2' },
    { type: 'response_done', at: T + 2900, responseId: 'R2', status: 'completed' },
    { type: 'tool_output_sent', at: T + 3300, callId: 'C2' },
    { type: 'forced_final_requested', at: T + 3400 },
  ]);

  it('resets on commit', () => {
    const next = run(
      [
        { type: 'speech_started', at: T + 30000 },
        { type: 'speech_stopped', at: T + 31000 },
        { type: 'committed', at: T + 31100 },
      ],
      spent,
    );

    expect(next.continuationsRequested).toBe(0);
    expect(next.forcedFinalRequested).toBe(0);
    expect(next.callsSeen).toEqual([]);
    expect(next.outputsSent).toEqual([]);
    expect(canRequestContinuation(next)).toBe(true);
  });

  it('does not reset on speech alone', () => {
    // Barging in and saying nothing that commits is not a new request, and
    // must not hand the model a fresh round of tools.
    const next = reduceTurn(spent, { type: 'speech_started', at: T + 30000 });

    expect(next.phase).toBe('listening');
    expect(next.continuationsRequested).toBe(1);
    expect(next.forcedFinalRequested).toBe(1);
  });
});

describe('G — did the model ask the same thing twice?', () => {
  it('reports the first call as FIRST', () => {
    expect(compareSignature(undefined, argumentSignature('{"a":1}'))).toBe('FIRST');
  });

  it('reports an identical call as SAME regardless of key order', () => {
    const first = argumentSignature('{"a":1,"b":[2,3]}');
    const second = argumentSignature('{"b":[2,3],"a":1}');

    expect(compareSignature(first, second)).toBe('SAME');
  });

  it('reports a changed argument as DIFFERENT', () => {
    const first = argumentSignature('{"query":"x"}');
    const second = argumentSignature('{"query":"y"}');

    expect(compareSignature(first, second)).toBe('DIFFERENT');
  });

  it('distinguishes array order, which changes meaning', () => {
    expect(
      compareSignature(argumentSignature('{"ids":[1,2]}'), argumentSignature('{"ids":[2,1]}')),
    ).toBe('DIFFERENT');
  });

  it('reports unparseable arguments rather than comparing them as text', () => {
    expect(argumentSignature('not json')).toBeNull();
    expect(compareSignature('abc', argumentSignature('not json'))).toBe('UNREADABLE');
  });

  it('never returns anything resembling the arguments', () => {
    const signature = argumentSignature('{"name":"じゃがいも","recipe":"肉じゃが"}');

    expect(signature).not.toBeNull();
    expect(signature).not.toContain('じゃがいも');
    expect(signature).not.toContain('肉じゃが');
    expect(signature!.length).toBeLessThanOrEqual(8);
  });
});
