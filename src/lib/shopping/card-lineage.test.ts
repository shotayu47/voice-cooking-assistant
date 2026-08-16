import { describe, expect, it } from 'vitest';

import {
  lineageKeyOf,
  lineageRoot,
  recipeIdsOf,
  REVISED_CARD_NOTICE,
  type RevisionChain,
} from './card-lineage';
import { withVoiceSuggestions, hasSuggestionCard, type ChatMessage } from './chat-suggestions';
import type { ShoppingSuggestion } from './suggest';

/**
 * After a recipe is revised, which card on screen is the stale one?
 *
 * A revision writes a new recipe row, so the new candidates arrive under a
 * different recipe id and a different call id — and the card built from 顆粒だし,
 * the ingredient the user had just asked to replace, stayed on screen looking
 * exactly as current as its replacement.
 */

function suggestion(name: string, recipeId = 'r1'): ShoppingSuggestion {
  return {
    name,
    reason: 'absent',
    reasonLabel: '在庫にない',
    quantity: null,
    unit: null,
    isStaple: false,
    alreadyOnList: false,
    sourceRecipes: [{ recipeId, title: '味噌汁' }],
  };
}

/** r2 was revised from r1; r3 from r2. */
const chain: RevisionChain = new Map([
  ['r2', 'r1'],
  ['r3', 'r2'],
]);

describe('following a recipe back to its original', () => {
  it('resolves a revision to the recipe it came from', () => {
    expect(lineageRoot('r2', chain)).toBe('r1');
  });

  it('follows a chain of revisions all the way back', () => {
    expect(lineageRoot('r3', chain)).toBe('r1');
  });

  it('leaves an unrevised recipe as its own root', () => {
    expect(lineageRoot('r1', chain)).toBe('r1');
    expect(lineageRoot('unrelated', chain)).toBe('unrelated');
  });

  it('does not hang on a malformed chain', () => {
    const cyclic: RevisionChain = new Map([
      ['a', 'b'],
      ['b', 'a'],
    ]);

    expect(['a', 'b']).toContain(lineageRoot('a', cyclic));
  });

  it('keys a multi-dish request by all of its roots', () => {
    expect(lineageKeyOf(['r2', 'x1'], chain)).toBe(lineageKeyOf(['x1', 'r1'], chain));
    expect(lineageKeyOf(['r1'], chain)).not.toBe(lineageKeyOf(['r1', 'x1'], chain));
  });

  it('reads the recipes out of the candidates themselves', () => {
    expect(recipeIdsOf([suggestion('水', 'r1'), suggestion('味噌', 'r2')])).toEqual(['r1', 'r2']);
  });
});

describe('a revised recipe replaces its own card', () => {
  const original = withVoiceSuggestions([], 'call_1', [
    suggestion('顆粒だし', 'r1'),
    suggestion('豆腐', 'r1'),
  ]);

  it('replaces the card built from the earlier version', () => {
    const revised = withVoiceSuggestions(original, 'call_2', [suggestion('かつお節', 'r2')], {
      chain,
      revised: true,
    });

    expect(revised.filter(hasSuggestionCard)).toHaveLength(1);
  });

  it('shows the new ingredients and drops the replaced one', () => {
    const revised = withVoiceSuggestions(
      original,
      'call_2',
      [suggestion('かつお節', 'r2'), suggestion('昆布', 'r2')],
      { chain, revised: true },
    );

    const names = revised.flatMap((m) => m.suggestions ?? []).map((s) => s.name);
    expect(names).toContain('かつお節');
    expect(names).not.toContain('顆粒だし');
  });

  it('says what happened, and that added items are still on the list', () => {
    const revised = withVoiceSuggestions(original, 'call_2', [suggestion('かつお節', 'r2')], {
      chain,
      revised: true,
    });

    expect(revised.at(-1)!.content).toBe(REVISED_CARD_NOTICE);
    expect(REVISED_CARD_NOTICE).toContain('すでに追加済みの項目は買い物リストに残ります');
  });

  it('gives the replacement a new message id, so nothing stays checked', () => {
    // The card's selection lives in the component. Replacing the message
    // in place would keep the old selection against new candidates.
    const revised = withVoiceSuggestions(original, 'call_2', [suggestion('かつお節', 'r2')], {
      chain,
      revised: true,
    });

    expect(revised.at(-1)!.id).not.toBe(original[0].id);
  });

  it('leaves a card for an unrelated dish alone', () => {
    const withOther = withVoiceSuggestions(original, 'call_2', [suggestion('にんじん', 'other')], {
      chain,
    });
    const revised = withVoiceSuggestions(withOther, 'call_3', [suggestion('かつお節', 'r2')], {
      chain,
      revised: true,
    });

    const names = revised.flatMap((m) => m.suggestions ?? []).map((s) => s.name);
    expect(names).toContain('にんじん');
    expect(names).toContain('かつお節');
    expect(names).not.toContain('顆粒だし');
  });
});

describe('a failure leaves the old card standing', () => {
  const original = withVoiceSuggestions([], 'call_1', [suggestion('顆粒だし', 'r1')]);

  it('keeps the old card when the revision produced no candidates', () => {
    // suggest_shopping_items failing, or returning nothing, must not clear the
    // card the user is looking at.
    const after = withVoiceSuggestions(original, 'call_2', [], { chain, revised: true });

    expect(after).toEqual(original);
    expect(after.filter(hasSuggestionCard)).toHaveLength(1);
  });

  it('keeps the old card when no revision happened at all', () => {
    // The revision failed, so nothing was recorded in the chain and the same
    // recipe is still current — a re-suggestion simply refreshes it.
    const after = withVoiceSuggestions(original, 'call_2', [suggestion('顆粒だし', 'r1')], {
      chain: new Map(),
    });

    expect(after.filter(hasSuggestionCard)).toHaveLength(1);
    expect(after.at(-1)!.content).not.toBe(REVISED_CARD_NOTICE);
  });

  it('does not remove anything from the shopping list', () => {
    // Nothing here writes; the card is a view. Rows the user confirmed live in
    // the database and are only ever removed by the user.
    const before: ChatMessage[] = original;
    const after = withVoiceSuggestions(before, 'call_2', [suggestion('かつお節', 'r2')], {
      chain,
      revised: true,
    });

    expect(after.every((m) => m.role === 'assistant')).toBe(true);
  });
});
