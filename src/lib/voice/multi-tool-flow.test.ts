import { describe, expect, it } from 'vitest';

import { argumentSignature } from './arg-signature';
import { decideRepeat, repeatKey, replayedOutput, REPEAT_SENSITIVE_TOOLS } from './tool-repeat';
import {
  canForceFinal,
  canRequestContinuation,
  INITIAL_TURN,
  MAX_TOOL_ROUNDS,
  reduceTurn,
  type TurnState,
  type VoiceEvent,
} from './turn-state';

/**
 * "レシピを作って、足りない材料の買い物候補を出して" — one request, two tools.
 *
 * It failed. `create_recipe` ran twice with different call ids, the second
 * trip exhausted a budget of one, the guard forced a final answer, and the
 * model filled the gap with "候補を上げるから待って" — while its response
 * completed and nothing was pending. `suggest_shopping_items` was never
 * reached; the user had to ask a second time.
 *
 * Two separate faults. The budget could not express a two-tool flow at all,
 * and the repeat was invisible because the only identity being checked was
 * `call_id`, which differs every time.
 */

function run(events: VoiceEvent[], from: TurnState = INITIAL_TURN): TurnState {
  return events.reduce(reduceTurn, from);
}

const T = 4_000_000;

const committed: VoiceEvent[] = [
  { type: 'speech_started', at: T },
  { type: 'speech_stopped', at: T + 400 },
  { type: 'committed', at: T + 500 },
];

/** One tool round: a response asks, the tool answers, a continuation follows. */
function toolRound(at: number, responseId: string, callId: string): VoiceEvent[] {
  return [
    { type: 'response_created', at, responseId },
    { type: 'function_call_ready', at: at + 100, callId },
    { type: 'response_done', at: at + 150, responseId, status: 'completed' },
    { type: 'tool_output_sent', at: at + 400, callId },
    { type: 'continuation_requested', at: at + 450 },
  ];
}

describe('the canonical two-tool flow completes', () => {
  it('allows a continuation after each of create_recipe and suggest_shopping_items', () => {
    let state = run(committed);

    // create_recipe
    expect(canRequestContinuation(state)).toBe(true);
    state = run(toolRound(T + 1000, 'R1', 'C1'), state);

    // suggest_shopping_items — this is the one the old budget refused.
    expect(canRequestContinuation(state)).toBe(true);
    state = run(toolRound(T + 3000, 'R2', 'C2'), state);

    // The spoken answer.
    state = run(
      [
        { type: 'response_created', at: T + 5000, responseId: 'R3' },
        { type: 'response_done', at: T + 8000, responseId: 'R3', status: 'completed' },
      ],
      state,
    );

    expect(state.phase).toBe('completed');
    expect(state.forcedFinalRequested).toBe(0);
  });

  it('never needed the forced final', () => {
    let state = run(committed);
    state = run(toolRound(T + 1000, 'R1', 'C1'), state);
    state = run(toolRound(T + 3000, 'R2', 'C2'), state);

    expect(state.continuationsRequested).toBe(2);
    expect(state.forcedFinalRequested).toBe(0);
  });
});

describe('the three-tool flow completes too', () => {
  it('carries search → create → suggest', () => {
    let state = run(committed);
    state = run(toolRound(T + 1000, 'R1', 'C1'), state); // search_meal_candidates
    expect(canRequestContinuation(state)).toBe(true);
    state = run(toolRound(T + 3000, 'R2', 'C2'), state); // create_recipe
    expect(canRequestContinuation(state)).toBe(true);
    state = run(toolRound(T + 5000, 'R3', 'C3'), state); // suggest_shopping_items

    state = run(
      [
        { type: 'response_created', at: T + 7000, responseId: 'R4' },
        { type: 'response_done', at: T + 9000, responseId: 'R4', status: 'completed' },
      ],
      state,
    );

    expect(state.continuationsRequested).toBe(3);
    expect(state.phase).toBe('completed');
  });

  it('leaves room for a retry at each stage', () => {
    // The device needed one: a create_recipe whose arguments failed to parse
    // was retried, and that retry alone used up the old budget of one.
    expect(MAX_TOOL_ROUNDS).toBeGreaterThanOrEqual(4);
  });
});

describe('the budget is finite', () => {
  it('stops after the ceiling rather than looping forever', () => {
    let state = run(committed);
    for (let i = 0; i < MAX_TOOL_ROUNDS; i += 1) {
      expect(canRequestContinuation(state)).toBe(true);
      state = run(toolRound(T + 1000 + i * 1000, `R${i}`, `C${i}`), state);
    }

    expect(canRequestContinuation(state)).toBe(false);
  });

  it('falls through to one forced final when it runs out', () => {
    let state = run(committed);
    for (let i = 0; i < MAX_TOOL_ROUNDS; i += 1) {
      state = run(toolRound(T + 1000 + i * 1000, `R${i}`, `C${i}`), state);
    }

    expect(canForceFinal(state)).toBe(true);
    const forced = reduceTurn(state, { type: 'forced_final_requested', at: T + 60000 });
    expect(forced.phase).toBe('awaiting_forced_final');
  });

  it('gives a fresh budget to the next committed request', () => {
    let state = run(committed);
    for (let i = 0; i < MAX_TOOL_ROUNDS; i += 1) {
      state = run(toolRound(T + 1000 + i * 1000, `R${i}`, `C${i}`), state);
    }

    const next = run(
      [
        { type: 'speech_started', at: T + 90000 },
        { type: 'speech_stopped', at: T + 91000 },
        { type: 'committed', at: T + 91100 },
      ],
      state,
    );

    expect(next.continuationsRequested).toBe(0);
    expect(canRequestContinuation(next)).toBe(true);
  });
});

describe('the same call is not made twice', () => {
  const args = '{"title":"肉じゃが","servings":2}';
  const signature = argumentSignature(args)!;
  const ran = new Set([repeatKey('create_recipe', signature)]);

  it('replays instead of creating a second recipe', () => {
    expect(decideRepeat('create_recipe', signature, ran)).toBe('replay');
  });

  it('ignores that the call id is different', () => {
    // The model issues a fresh id every time; identity is the tool and the
    // arguments, not the id.
    expect(decideRepeat('create_recipe', signature, ran)).toBe('replay');
  });

  it('runs a genuinely different request', () => {
    const other = argumentSignature('{"title":"肉じゃが","servings":4}')!;

    expect(other).not.toBe(signature);
    expect(decideRepeat('create_recipe', other, ran)).toBe('execute');
  });

  it('does not suppress read-only tools', () => {
    // Asking the same question twice is wasteful, not harmful, and the budget
    // already bounds it.
    expect(decideRepeat('suggest_shopping_items', signature, ran)).toBe('execute');
    expect(decideRepeat('search_meal_candidates', signature, ran)).toBe('execute');
  });

  it('covers the creating tools', () => {
    expect([...REPEAT_SENSITIVE_TOOLS].sort()).toEqual([
      'add_inventory_item',
      'create_recipe',
      'revise_recipe',
      'start_cooking_session',
    ]);
  });

  it('executes when the arguments could not be parsed', () => {
    // Exactly the device's first create_recipe: unparseable arguments, which
    // the tool rejected with invalid_arguments. Two payloads that could not be
    // compared are not known to be the same call, so the corrected retry runs.
    expect(argumentSignature('{"title":')).toBeNull();
    expect(decideRepeat('create_recipe', null, ran)).toBe('execute');
  });

  it('still hands the model an output, so it does not wait forever', () => {
    const replayed = replayedOutput({ recipe_id: 'r1', title: 'x' }) as Record<string, unknown>;

    expect(replayed.repeated).toBe(true);
    expect(replayed.recipe_id).toBe('r1');
    expect(String(replayed.note)).toContain('実行済み');
  });
});
