import { describe, expect, it } from 'vitest';

import {
  lineageRoot,
  NO_REVISIONS,
  revisionEdgeOf,
  withRevisionEdge,
  type RevisionChain,
} from './card-lineage';
import { hasSuggestionCard, withVoiceSuggestions, type ChatMessage } from './chat-suggestions';
import type { ShoppingSuggestion } from './suggest';

/**
 * A dish revised more than once, across separate utterances.
 *
 * The chain used to be rebuilt on every commit, so it never held more than one
 * link. R2 knew it came from R1 and its card replaced R1's; R3 knew only that
 * it came from R2, so its card keyed on R2 while the card on screen keyed on
 * R1 — and both stayed up, the older one still listing the candidates for the
 * version the user had just replaced. That is the failure §22 fixed for the
 * first revision, returning at the second.
 *
 * These tests drive the same order the client does: the revision is reported
 * first, the accumulated chain is read, and only then are the candidates
 * placed. Building the final map by hand would prove the lookup works while
 * skipping the part that was broken.
 */

const R1 = 'recipe-1';
const R2 = 'recipe-2';
const R3 = 'recipe-3';
const R4 = 'recipe-4';
const X1 = 'other-dish-1';

function candidate(name: string, recipeId: string): ShoppingSuggestion {
  return {
    name,
    reason: 'absent',
    reasonLabel: '在庫にない',
    quantity: null,
    unit: null,
    isStaple: false,
    alreadyOnList: false,
    sourceRecipes: [{ recipeId, title: 'スープ' }],
  };
}

/**
 * The page as far as this behaviour is concerned: a conversation-scoped chain
 * and the transcript, driven through the two callbacks the voice panel calls.
 */
function conversation() {
  let chain: RevisionChain = NO_REVISIONS;
  let messages: ChatMessage[] = [];
  let callSeq = 0;

  return {
    /** `reportRevision` — fires for a successful revision, card or no card. */
    revision(tool: string, result: unknown) {
      if (tool !== 'revise_recipe') return;
      chain = withRevisionEdge(chain, revisionEdgeOf(result));
    },
    /** `showCard` — only ever called with a non-empty list. */
    candidates(suggestions: ShoppingSuggestion[], revised = false) {
      if (suggestions.length === 0) return;
      callSeq += 1;
      messages = withVoiceSuggestions(messages, `call-${callSeq}`, suggestions, {
        chain,
        revised,
      });
    },
    /** What `startNew` does once the server confirms the switch. */
    newConversation() {
      messages = [];
      chain = NO_REVISIONS;
    },
    cards: () => messages.filter(hasSuggestionCard),
    chain: () => chain,
  };
}

/** What the tool returns for a revision that saved a row. */
const revisionResult = (recipeId: string, supersedes: string) => ({
  recipe_id: recipeId,
  supersedes_recipe_id: supersedes,
  title: 'スープ',
  total_steps: 4,
});

describe('one card however many revisions', () => {
  it('draws one card for the first recipe', () => {
    const page = conversation();

    page.candidates([candidate('豆腐', R1)]);

    expect(page.cards()).toHaveLength(1);
    expect(page.cards()[0].lineageKey).toBe(R1);
  });

  it('replaces that card on the first revision', () => {
    const page = conversation();
    page.candidates([candidate('豆腐', R1)]);

    page.revision('revise_recipe', revisionResult(R2, R1));
    page.candidates([candidate('味噌', R2)], true);

    expect(page.cards()).toHaveLength(1);
    expect(page.cards()[0].lineageKey).toBe(R1);
    expect(page.cards()[0].suggestions?.map((s) => s.name)).toEqual(['味噌']);
  });

  it('still replaces it on the second revision, an utterance later', () => {
    // The one that used to fail: before, the chain had been rebuilt by the
    // time R3 arrived and knew nothing about R1.
    const page = conversation();
    page.candidates([candidate('豆腐', R1)]);
    page.revision('revise_recipe', revisionResult(R2, R1));
    page.candidates([candidate('味噌', R2)], true);

    page.revision('revise_recipe', revisionResult(R3, R2));
    page.candidates([candidate('酢', R3)], true);

    expect(page.cards()).toHaveLength(1);
    expect(page.cards()[0].lineageKey).toBe(R1);
    expect(page.cards()[0].suggestions?.map((s) => s.name)).toEqual(['酢']);
  });

  it('holds at one card through a fourth version', () => {
    const page = conversation();
    page.candidates([candidate('豆腐', R1)]);
    for (const [to, from, name] of [
      [R2, R1, '味噌'],
      [R3, R2, '酢'],
      [R4, R3, 'みりん'],
    ] as const) {
      page.revision('revise_recipe', revisionResult(to, from));
      page.candidates([candidate(name, to)], true);
    }

    expect(page.cards()).toHaveLength(1);
    expect(page.cards()[0].lineageKey).toBe(R1);
    expect(page.cards()[0].suggestions?.map((s) => s.name)).toEqual(['みりん']);
  });

  it('leaves another dish’s card alone', () => {
    const page = conversation();
    page.candidates([candidate('豆腐', R1)]);
    page.candidates([candidate('鮭', X1)]);

    page.revision('revise_recipe', revisionResult(R2, R1));
    page.candidates([candidate('味噌', R2)], true);
    page.revision('revise_recipe', revisionResult(R3, R2));
    page.candidates([candidate('酢', R3)], true);

    const keys = page.cards().map((c) => c.lineageKey);
    expect(page.cards()).toHaveLength(2);
    expect(keys).toContain(R1);
    expect(keys).toContain(X1);
    expect(page.cards().find((c) => c.lineageKey === X1)?.suggestions?.map((s) => s.name)).toEqual([
      '鮭',
    ]);
  });
});

describe('a revision that drew no card is still remembered', () => {
  /*
   * The reason the revision is reported separately from the candidates. Each
   * of these saved a recipe row and drew nothing, and the revision after it
   * has to be able to trace the lineage back through it.
   */
  const drewNothing = [
    ['mode none', []],
    ['an empty candidate list', []],
    ['a failed candidate read', []],
  ] as const;

  it.each(drewNothing)('carries the lineage across %s', (_label, none) => {
    const page = conversation();
    page.candidates([candidate('豆腐', R1)]);

    // The revision succeeded; only the card is missing.
    page.revision('revise_recipe', revisionResult(R2, R1));
    page.candidates([...none]);

    page.revision('revise_recipe', revisionResult(R3, R2));
    page.candidates([candidate('酢', R3)], true);

    expect(page.cards()).toHaveLength(1);
    expect(page.cards()[0].lineageKey).toBe(R1);
    expect(page.cards()[0].suggestions?.map((s) => s.name)).toEqual(['酢']);
  });

  it('leaves the old card up while nothing new is drawn', () => {
    const page = conversation();
    page.candidates([candidate('豆腐', R1)]);

    page.revision('revise_recipe', revisionResult(R2, R1));
    page.candidates([]);

    expect(page.cards()).toHaveLength(1);
    expect(page.cards()[0].suggestions?.map((s) => s.name)).toEqual(['豆腐']);
  });
});

describe('a revision that did not save a row', () => {
  it('records no edge, so the card that is up stays current', () => {
    const page = conversation();
    page.candidates([candidate('豆腐', R1)]);

    // What a failed revise_recipe returns: an error, and neither id.
    page.revision('revise_recipe', {
      error: 'invalid_arguments',
      message: '変更元の recipe_id が必要です',
    });

    expect(page.chain().size).toBe(0);
    expect(page.cards()).toHaveLength(1);
    expect(page.cards()[0].suggestions?.map((s) => s.name)).toEqual(['豆腐']);
  });

  it('records nothing for a create, which supersedes nothing', () => {
    const page = conversation();

    page.revision('create_recipe', { recipe_id: R1, title: 'スープ', total_steps: 4 });

    expect(page.chain().size).toBe(0);
  });
});

describe('a repeat reports the same revision again', () => {
  it('does not grow the chain or the cards', () => {
    const page = conversation();
    page.candidates([candidate('豆腐', R1)]);
    page.revision('revise_recipe', revisionResult(R2, R1));
    page.candidates([candidate('味噌', R2)], true);

    // replay and reuse both re-report the stored result.
    page.revision('revise_recipe', revisionResult(R2, R1));
    page.candidates([candidate('味噌', R2)], true);
    page.revision('revise_recipe', revisionResult(R2, R1));
    page.candidates([candidate('味噌', R2)], true);

    expect(page.chain().size).toBe(1);
    expect(page.cards()).toHaveLength(1);
    expect(page.cards()[0].lineageKey).toBe(R1);
  });
});

describe('the lineage lasts exactly as long as the cards', () => {
  it('is dropped when a new conversation starts', () => {
    const page = conversation();
    page.candidates([candidate('豆腐', R1)]);
    page.revision('revise_recipe', revisionResult(R2, R1));
    page.candidates([candidate('味噌', R2)], true);

    page.newConversation();

    expect(page.chain().size).toBe(0);
    expect(page.cards()).toHaveLength(0);

    // A revision in the new conversation keys on its own ancestor, not on one
    // from a conversation the user has left.
    page.revision('revise_recipe', revisionResult(R3, R2));
    page.candidates([candidate('酢', R3)], true);

    expect(page.cards()).toHaveLength(1);
    expect(page.cards()[0].lineageKey).toBe(R2);
  });

  it('survives a voice reconnect, which clears nothing here', () => {
    // Disconnecting tears down the call; it does not end the conversation, and
    // the cards stay on screen — so the lineage that keys them stays too.
    const page = conversation();
    page.candidates([candidate('豆腐', R1)]);
    page.revision('revise_recipe', revisionResult(R2, R1));
    page.candidates([candidate('味噌', R2)], true);

    // Nothing happens to the page state on reconnect.

    page.revision('revise_recipe', revisionResult(R3, R2));
    page.candidates([candidate('酢', R3)], true);

    expect(page.cards()).toHaveLength(1);
    expect(page.cards()[0].lineageKey).toBe(R1);
  });
});

describe('withRevisionEdge', () => {
  it('does not touch the chain it is given', () => {
    const before: RevisionChain = new Map([[R2, R1]]);
    const after = withRevisionEdge(before, { recipeId: R3, supersedesRecipeId: R2 });

    expect(before.size).toBe(1);
    expect(after.size).toBe(2);
    expect(after).not.toBe(before);
  });

  it('is idempotent for an edge it already holds', () => {
    const chain = withRevisionEdge(NO_REVISIONS, { recipeId: R2, supersedesRecipeId: R1 });
    const again = withRevisionEdge(chain, { recipeId: R2, supersedesRecipeId: R1 });

    expect(again).toBe(chain);
    expect(again.size).toBe(1);
  });

  it('holds several lineages at once', () => {
    let chain = withRevisionEdge(NO_REVISIONS, { recipeId: R2, supersedesRecipeId: R1 });
    chain = withRevisionEdge(chain, { recipeId: 'other-2', supersedesRecipeId: X1 });
    chain = withRevisionEdge(chain, { recipeId: R3, supersedesRecipeId: R2 });

    expect(lineageRoot(R3, chain)).toBe(R1);
    expect(lineageRoot('other-2', chain)).toBe(X1);
  });

  it('ignores a missing or empty edge', () => {
    expect(withRevisionEdge(NO_REVISIONS, null)).toBe(NO_REVISIONS);
    expect(withRevisionEdge(NO_REVISIONS, undefined)).toBe(NO_REVISIONS);
    expect(withRevisionEdge(NO_REVISIONS, { recipeId: '', supersedesRecipeId: R1 })).toBe(
      NO_REVISIONS,
    );
    expect(withRevisionEdge(NO_REVISIONS, { recipeId: R2, supersedesRecipeId: '' })).toBe(
      NO_REVISIONS,
    );
  });

  it('leaves the cycle guard doing its job', () => {
    // Not special cased here: lineageRoot already stops rather than looping.
    const selfish = withRevisionEdge(NO_REVISIONS, { recipeId: R2, supersedesRecipeId: R2 });
    expect(lineageRoot(R2, selfish)).toBe(R2);

    let cyclic = withRevisionEdge(NO_REVISIONS, { recipeId: 'a', supersedesRecipeId: 'b' });
    cyclic = withRevisionEdge(cyclic, { recipeId: 'b', supersedesRecipeId: 'a' });
    expect(['a', 'b']).toContain(lineageRoot('a', cyclic));
  });
});

describe('revisionEdgeOf', () => {
  it('reads both ids out of a successful revision', () => {
    expect(revisionEdgeOf(revisionResult(R2, R1))).toEqual({
      recipeId: R2,
      supersedesRecipeId: R1,
    });
  });

  it('reads an integrated result the same way', () => {
    // The candidates travel in the same object; the ids are unaffected.
    expect(
      revisionEdgeOf({
        ...revisionResult(R2, R1),
        shopping_suggestions_handled: true,
        shopping_suggestions: { status: 'ok', suggestions: [{ name: '味噌' }], added: false },
      }),
    ).toEqual({ recipeId: R2, supersedesRecipeId: R1 });
  });

  it('returns nothing when a row was not written', () => {
    for (const result of [
      null,
      undefined,
      'revise_recipe',
      42,
      {},
      { error: 'invalid_arguments' },
      { recipe_id: R2 },
      { supersedes_recipe_id: R1 },
      { recipe_id: R2, supersedes_recipe_id: null },
    ]) {
      expect(revisionEdgeOf(result)).toBeNull();
    }
  });
});
