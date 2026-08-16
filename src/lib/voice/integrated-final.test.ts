import { describe, expect, it } from 'vitest';

import {
  hasSuggestionCard,
  withVoiceSuggestions,
  type ChatMessage,
} from '@/lib/shopping/chat-suggestions';
import { initialCardState } from '@/lib/shopping/suggestion-card-state';
import type { ShoppingSuggestion } from '@/lib/shopping/suggest';

import {
  carriesIntegratedSuggestions,
  continuationAfterTool,
  INTEGRATED_FINAL_INSTRUCTIONS,
} from './integrated-final';
import { replayedOutput } from './tool-repeat';
import {
  canRequestContinuation,
  INITIAL_TURN,
  reduceTurn,
  type TurnState,
  type VoiceEvent,
} from './turn-state';

/**
 * One request, two responses.
 *
 * "レシピを作って、足りない材料の買い物候補も出して" completed in three
 * responses: the tool call, a continuation that called
 * `suggest_shopping_items`, and a third for the sentence. Each one re-sends the
 * conversation — measured at roughly 10,000 input tokens — against a project
 * allowance that ran out mid-conversation during device QA.
 *
 * With the candidates folded into the recipe tool's result, the middle response
 * has nothing to do. What these tests pin is that it cannot come back: the
 * closing reply is asked for with `tool_choice: 'none'`, so a model that would
 * have called `suggest_shopping_items` anyway structurally cannot.
 */

const RECIPE_ID = 'recipe-new';
const SOURCE_RECIPE_ID = 'recipe-original';

/** What `create_recipe` returns when it carried the candidates. */
function integratedResult(overrides: Record<string, unknown> = {}) {
  return {
    recipe_id: RECIPE_ID,
    title: '肉じゃが',
    total_steps: 4,
    shopping_suggestions_included: true,
    shopping_suggestions: { status: 'ok', suggestions: [{ name: '玉ねぎ' }], added: false },
    ...overrides,
  };
}

describe('recognising a result that already carries its candidates', () => {
  it('recognises both recipe tools', () => {
    expect(carriesIntegratedSuggestions('create_recipe', integratedResult())).toBe(true);
    expect(carriesIntegratedSuggestions('revise_recipe', integratedResult())).toBe(true);
  });

  it('does not recognise a recipe saved without the flag', () => {
    expect(
      carriesIntegratedSuggestions('create_recipe', { recipe_id: RECIPE_ID, title: '肉じゃが' }),
    ).toBe(false);
  });

  it('recognises a failed computation too', () => {
    // The model still is not going to call the other tool, and the reply still
    // has to explain what happened. Only the marker decides, not the outcome.
    const failed = integratedResult({
      shopping_suggestions: { status: 'failed', message: 'レシピは保存できましたが…' },
    });

    expect(carriesIntegratedSuggestions('create_recipe', failed)).toBe(true);
  });

  it('recognises an empty list', () => {
    const empty = integratedResult({
      shopping_suggestions: { status: 'ok', suggestions: [], added: false },
    });

    expect(carriesIntegratedSuggestions('create_recipe', empty)).toBe(true);
  });

  it('never closes the door on a tool that cannot carry candidates', () => {
    // `suggest_shopping_items` is a route to more tools like any other. Reading
    // the marker off any tool would let a stray field end a turn early.
    expect(carriesIntegratedSuggestions('suggest_shopping_items', integratedResult())).toBe(false);
    expect(carriesIntegratedSuggestions('search_meal_candidates', integratedResult())).toBe(false);
  });

  it('is unmoved by anything that is not the flag set true', () => {
    for (const result of [
      null,
      undefined,
      'shopping_suggestions_included',
      42,
      {},
      { shopping_suggestions_included: false },
      { shopping_suggestions_included: 'true' },
      { error: 'invalid_arguments' },
    ]) {
      expect(carriesIntegratedSuggestions('create_recipe', result)).toBe(false);
    }
  });
});

describe('the reply that follows the tool output', () => {
  it('forbids further tools structurally, not by asking', () => {
    const { payload, purpose } = continuationAfterTool('create_recipe', integratedResult());

    expect(purpose).toBe('integrated_final');
    expect(payload.type).toBe('response.create');
    // The instruction below says so in words; this is the part the server
    // enforces.
    expect(payload.response?.tool_choice).toBe('none');
  });

  it('labels itself so the trace can tell a two-response turn from a three', () => {
    const { payload } = continuationAfterTool('revise_recipe', integratedResult());

    expect(payload.response?.metadata).toEqual({ purpose: 'integrated_final' });
  });

  it('tells the model both halves are already in hand', () => {
    const { payload } = continuationAfterTool('create_recipe', integratedResult());

    expect(payload.response?.instructions).toBe(INTEGRATED_FINAL_INSTRUCTIONS);
    expect(INTEGRATED_FINAL_INSTRUCTIONS).toContain('suggest_shopping_items を呼ぼうとしない');
  });

  it('keeps the promise ban that the device turn needed', () => {
    // 「候補を上げるから待って」 followed by silence: nothing runs after this
    // response, so a promise to continue is one that cannot be kept.
    expect(INTEGRATED_FINAL_INSTRUCTIONS).toContain('お待ちください');
    expect(INTEGRATED_FINAL_INSTRUCTIONS).toContain('約束してはいけません');
  });

  it('says what to do when the candidates failed', () => {
    expect(INTEGRATED_FINAL_INSTRUCTIONS).toContain('レシピは保存できたこと');
    expect(INTEGRATED_FINAL_INSTRUCTIONS).toContain('レシピを作り直してはいけません');
  });

  it('says what to do when there was nothing to buy', () => {
    expect(INTEGRATED_FINAL_INSTRUCTIONS).toContain('買い足すものはありません');
  });

  it('leaves an ordinary tool with an ordinary continuation', () => {
    const { payload, purpose } = continuationAfterTool('search_meal_candidates', {
      candidates: [],
    });

    expect(purpose).toBe('continuation');
    // No `response` block at all: the next response may call tools, which is
    // what a multi-tool flow still needs.
    expect(payload).toEqual({ type: 'response.create' });
  });

  it('leaves a recipe saved without candidates free to call another tool', () => {
    const { payload, purpose } = continuationAfterTool('create_recipe', {
      recipe_id: RECIPE_ID,
      title: '肉じゃが',
    });

    expect(purpose).toBe('continuation');
    expect(payload.response).toBeUndefined();
  });

  it('carries through a replayed result, which keeps its marker', () => {
    // A repeat is answered from the stored result rather than re-run, and that
    // stored result is still an integrated one — so the reply is still final.
    const replayed = replayedOutput(integratedResult());

    expect(carriesIntegratedSuggestions('create_recipe', replayed)).toBe(true);
    expect(continuationAfterTool('create_recipe', replayed).purpose).toBe('integrated_final');
  });
});

/** The events one tool round produces, as the client emits them. */
function toolRound(at: number, responseId: string, callId: string): VoiceEvent[] {
  return [
    { type: 'response_created', at, responseId },
    { type: 'function_call_ready', at: at + 100, callId },
    { type: 'response_done', at: at + 150, responseId, status: 'completed' },
    { type: 'tool_output_sent', at: at + 400, callId },
    { type: 'continuation_requested', at: at + 450 },
  ];
}

function run(events: VoiceEvent[], from: TurnState = INITIAL_TURN): TurnState {
  return events.reduce(reduceTurn, from);
}

const T = 5_000_000;

const committed: VoiceEvent[] = [
  { type: 'speech_started', at: T },
  { type: 'speech_stopped', at: T + 400 },
  { type: 'committed', at: T + 500 },
];

describe('the turn now costs two responses instead of three', () => {
  it('completes after the automatic response and one closing reply', () => {
    let state = run(committed);

    // R1: the automatic response, which asks for create_recipe. Its output
    // carries the candidates, so the continuation is the closing reply.
    state = run(toolRound(T + 1000, 'R1', 'C1'), state);
    expect(continuationAfterTool('create_recipe', integratedResult()).purpose).toBe(
      'integrated_final',
    );

    // R2: the reply itself. No tool call is possible inside it.
    state = run(
      [
        { type: 'response_created', at: T + 2000, responseId: 'R2' },
        { type: 'response_done', at: T + 6000, responseId: 'R2', status: 'completed' },
      ],
      state,
    );

    expect(state.phase).toBe('completed');
    expect(state.continuationsRequested).toBe(1);
    // Two responses total, and the recovery path was never needed.
    expect(state.forcedFinalRequested).toBe(0);
  });

  it('spends one fewer continuation than the same request did unintegrated', () => {
    const integrated = run(toolRound(T + 1000, 'R1', 'C1'), run(committed));

    const separate = run(
      toolRound(T + 3000, 'R2', 'C2'), // suggest_shopping_items
      run(toolRound(T + 1000, 'R1', 'C1'), run(committed)), // create_recipe
    );

    expect(integrated.continuationsRequested).toBe(1);
    expect(separate.continuationsRequested).toBe(2);
  });

  it('still spends the continuation, so the watchdog and the budget both apply', () => {
    // The closing reply is not a special case in the state machine — it is a
    // continuation with a different payload. Treating it as free would leave a
    // silent reply unmonitored.
    const state = run(toolRound(T + 1000, 'R1', 'C1'), run(committed));

    expect(state.continuationsRequested).toBe(1);
    expect(canRequestContinuation(state)).toBe(true);
  });

  it('leaves the multi-tool budget alone for flows that still need it', () => {
    // search → create → suggest is unaffected: nothing in that chain carries
    // candidates until the last step.
    let state = run(committed);
    state = run(toolRound(T + 1000, 'R1', 'C1'), state);
    state = run(toolRound(T + 3000, 'R2', 'C2'), state);
    state = run(toolRound(T + 5000, 'R3', 'C3'), state);

    expect(state.continuationsRequested).toBe(3);
    expect(canRequestContinuation(state)).toBe(true);
  });
});

describe('the closing reply is not the forced final', () => {
  it('does not tell a healthy turn it was cut off', () => {
    // The forced final is a recovery: the budget is spent and the turn is in
    // trouble. Reusing its wording here would say the tools stopped working,
    // when in fact nothing more was needed.
    expect(INTEGRATED_FINAL_INSTRUCTIONS).not.toContain('これ以上ツールを呼び出すことはできません。追加の情報取得');
    expect(INTEGRATED_FINAL_INSTRUCTIONS).toContain('すでに揃っています');
  });

  it('goes through the ordinary continuation event, so retry stays available', () => {
    // `forced_final_*` failures end with canRetry false, on purpose. A turn
    // that simply answered in two responses must not inherit that.
    const state = run(toolRound(T + 1000, 'R1', 'C1'), run(committed));

    expect(state.phase).toBe('continuing_after_tool');
    expect(state.forcedFinalRequested).toBe(0);
    expect(state.failure).toBeNull();
  });
});

function suggestion(name: string, recipeId: string, title: string): ShoppingSuggestion {
  return {
    name,
    reason: 'absent',
    reasonLabel: '在庫にありません',
    quantity: 1,
    unit: '個',
    isStaple: false,
    alreadyOnList: false,
    sourceRecipes: [{ recipeId, title }],
  };
}

describe('the card the folded candidates draw', () => {
  const chain = new Map([[RECIPE_ID, SOURCE_RECIPE_ID]]);

  const firstCard = withVoiceSuggestions(
    [],
    'call-create',
    [suggestion('顆粒だし', SOURCE_RECIPE_ID, '味噌汁')],
    { chain: new Map() },
  );

  it('replaces the card built from the version being revised', () => {
    const revised = withVoiceSuggestions(
      firstCard,
      'call-revise',
      [suggestion('昆布', RECIPE_ID, '味噌汁（だしから）')],
      { chain, revised: true },
    );

    // One panel, not two beside each other.
    expect(revised.filter(hasSuggestionCard)).toHaveLength(1);
    expect(revised.find(hasSuggestionCard)?.suggestions?.map((entry) => entry.name)).toEqual([
      '昆布',
    ]);
  });

  it('keeps the lineage across a revision, which is what makes it a replacement', () => {
    const revised = withVoiceSuggestions(
      firstCard,
      'call-revise',
      [suggestion('昆布', RECIPE_ID, '味噌汁（だしから）')],
      { chain, revised: true },
    );

    expect(revised.find(hasSuggestionCard)?.lineageKey).toBe(SOURCE_RECIPE_ID);
  });

  it('starts a replacement with nothing ticked', () => {
    const revised = withVoiceSuggestions(
      firstCard,
      'call-revise',
      [suggestion('昆布', RECIPE_ID, '味噌汁（だしから）')],
      { chain, revised: true },
    );
    const card = revised.find(hasSuggestionCard) as ChatMessage;

    // The card is a new message id, so the component remounts into this state.
    expect(card.id).not.toBe(firstCard[0].id);
    expect(initialCardState('req-1').picked.size).toBe(0);
    expect(initialCardState('req-1').added.size).toBe(0);
  });

  it('draws nothing when the folded computation found nothing to buy', () => {
    expect(withVoiceSuggestions([], 'call-create', [])).toEqual([]);
  });

  it('leaves the previous card standing when the folded computation failed', () => {
    // A failure sends no suggestions at all, and an empty list is a no-op — so
    // the card the user was looking at is not taken away by a failed revision.
    expect(withVoiceSuggestions(firstCard, 'call-revise', [], { chain, revised: true })).toEqual(
      firstCard,
    );
  });

  it('replays to the same single card rather than a second one', () => {
    // A repeat re-emits the stored candidates under a fresh call id. Keyed by
    // lineage, that lands on the card that is already there.
    const replayed = withVoiceSuggestions(
      firstCard,
      'call-create-again',
      [suggestion('顆粒だし', SOURCE_RECIPE_ID, '味噌汁')],
      { chain: new Map() },
    );

    expect(replayed.filter(hasSuggestionCard)).toHaveLength(1);
  });
});
